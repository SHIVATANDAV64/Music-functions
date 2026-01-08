import { Client, Storage } from 'node-appwrite';
import { File, Blob } from 'web-file-polyfill';
import crypto from 'crypto';

const ALLOWED_DOMAINS = [
    'prod-1.storage.jamendo.com',
    'storage.jamendo.com',
    'mp3l.jamendo.com',
    'mp3d.jamendo.com',
    'fra.cloud.appwrite.io',
    'cloud.appwrite.io',
    'audioos.appwrite.network', // User's custom domain
];

const BUCKET_ID = 'audio_files';

export default async ({ req, res, log, error }: any) => {
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

        // Create a unique file ID based on the URL or Jamendo ID
        let fileId: string;

        // Try to extract Jamendo Track ID for stable caching (avoids duplicates from query params)
        // Matches: /track/123/ or trackid=123
        const jamendoIdMatch = decodedUrl.match(/\/track\/(\d+)/) || decodedUrl.match(/trackid=(\d+)/);

        if (jamendoIdMatch && jamendoIdMatch[1]) {
            fileId = `jamendo_${jamendoIdMatch[1]}`;
            log(`Identified Jamendo Track ID: ${jamendoIdMatch[1]} -> ${fileId}`);
        } else {
            // Fallback for other files
            fileId = crypto.createHash('md5').update(decodedUrl).digest('hex');
        }

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
        log(`Uploading ${audioBufferNode.length} bytes to bucket...`);

        try {
            // Appwrite Node SDK v14+ uses the standard File object.
            // Using web-file-polyfill for Node < 22 compatibility.
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
