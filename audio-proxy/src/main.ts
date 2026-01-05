import { Client, Storage, ID } from 'node-appwrite';
import crypto from 'crypto';

interface FunctionContext {
    req: {
        query: Record<string, string>;
        headers: Record<string, string>;
        method: string;
        path: string;
    };
    res: {
        send: (data: Uint8Array | string, status?: number, headers?: Record<string, string>) => void;
        json: (data: unknown, status?: number, headers?: Record<string, string>) => void;
    };
    log: (message: string) => void;
    error: (message: string) => void;
}

const ALLOWED_DOMAINS = [
    'prod-1.storage.jamendo.com',
    'storage.jamendo.com',
    'mp3l.jamendo.com',
    'mp3d.jamendo.com',
];

const BUCKET_ID = 'audio_files';

export default async ({ req, res, log, error }: FunctionContext) => {
    const audioUrl = req.query?.url;

    if (!audioUrl) {
        return res.json({ success: false, error: 'Missing url parameter' }, 400);
    }

    try {
        const decodedUrl = decodeURIComponent(audioUrl);
        const url = new URL(decodedUrl);

        if (!ALLOWED_DOMAINS.some(domain => url.hostname.endsWith(domain))) {
            return res.json({ success: false, error: 'Unauthorized domain' }, 403);
        }

        // Initialize Appwrite
        const client = new Client()
            .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT!)
            .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID!)
            .setKey(process.env.APPWRITE_API_KEY!);

        const storage = new Storage(client);

        // Create a unique file ID based on the URL
        const fileId = crypto.createHash('md5').update(decodedUrl).digest('hex');

        // 1. Check if file already exists in cache
        try {
            await storage.getFile(BUCKET_ID, fileId);
            log(`Cache hit for: ${fileId}`);
            return res.json({ success: true, fileId });
        } catch (e) {
            log(`Cache miss for: ${fileId}. Fetching from Jamendo...`);
        }

        // 2. Fetch from Jamendo
        const response = await fetch(decodedUrl, {
            headers: { 'User-Agent': 'MusicStreamingApp/1.0' },
        });

        if (!response.ok) {
            throw new Error(`Upstream error: ${response.status}`);
        }

        const audioBuffer = await response.arrayBuffer();
        const audioBufferNode = Buffer.from(audioBuffer);

        // 3. Upload to Appwrite Storage
        // Appwrite Node SDK v14+ uses the standard File object (global in Node.js 21)
        log(`Uploading ${audioBufferNode.length} bytes to bucket...`);

        try {
            const fileToUpload = new File(
                [audioBufferNode],
                `${fileId}.mp3`,
                { type: 'audio/mpeg' }
            );

            await (storage as any).createFile(
                BUCKET_ID,
                fileId,
                fileToUpload,
                ['read("any")']
            );
            log(`Successfully cached track: ${fileId}`);
        } catch (uploadError: any) {
            error(`Upload failed: ${uploadError.message}`);
            throw uploadError;
        }

        return res.json({ success: true, fileId });

    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        error(`Proxy error: ${message}`);
        return res.json({ success: false, error: message }, 500);
    }
};
