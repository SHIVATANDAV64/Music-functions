/**
 * Audio Proxy Function
 * Proxies Jamendo audio streams with CORS headers to enable Web Audio API analysis
 * 
 * CORS Issue: Jamendo's CDN doesn't send Access-Control-Allow-Origin headers,
 * so browsers block Web Audio API from analyzing cross-origin audio.
 * This proxy fetches the audio and serves it with proper CORS headers.
 * 
 * @endpoint GET /audio-proxy?url=<encoded_audio_url>
 */

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

// Allowed domains for security - only proxy from trusted sources
const ALLOWED_DOMAINS = [
    'prod-1.storage.jamendo.com',
    'storage.jamendo.com',
    'mp3l.jamendo.com',
    'mp3d.jamendo.com',
];

export default async ({ req, res, log, error }: FunctionContext) => {
    // Get the audio URL from query parameter
    const audioUrl = req.query?.url;

    // CORS headers for all responses
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Content-Type',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    };

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        return res.send('', 204, corsHeaders);
    }

    // Validate URL parameter
    if (!audioUrl) {
        error('Missing url parameter');
        return res.json({
            success: false,
            error: 'Missing url parameter'
        }, 400, corsHeaders);
    }

    try {
        // Decode and validate the URL
        const decodedUrl = decodeURIComponent(audioUrl);
        const url = new URL(decodedUrl);

        // Security check: Only allow whitelisted domains
        if (!ALLOWED_DOMAINS.some(domain => url.hostname.endsWith(domain))) {
            error(`Blocked request to unauthorized domain: ${url.hostname}`);
            return res.json({
                success: false,
                error: 'Unauthorized domain'
            }, 403, corsHeaders);
        }

        log(`Proxying audio from: ${url.hostname}`);

        // Prepare headers for the upstream request
        const proxyHeaders: Record<string, string> = {
            'User-Agent': 'MusicStreamingApp/1.0',
        };

        // Forward Range header for seek support
        if (req.headers['range']) {
            proxyHeaders['Range'] = req.headers['range'];
        }

        // Fetch the audio from Jamendo
        const response = await fetch(decodedUrl, {
            method: req.method === 'HEAD' ? 'HEAD' : 'GET',
            headers: proxyHeaders,
        });

        if (!response.ok && response.status !== 206) {
            error(`Upstream error: ${response.status} ${response.statusText}`);
            return res.json({
                success: false,
                error: `Upstream error: ${response.status}`
            }, response.status, corsHeaders);
        }

        // Build response headers
        const responseHeaders: Record<string, string> = {
            ...corsHeaders,
            'Content-Type': response.headers.get('Content-Type') || 'audio/mpeg',
            'Cache-Control': 'public, max-age=86400', // Cache for 24 hours
        };

        // Forward content-related headers
        const contentLength = response.headers.get('Content-Length');
        if (contentLength) {
            responseHeaders['Content-Length'] = contentLength;
        }

        const contentRange = response.headers.get('Content-Range');
        if (contentRange) {
            responseHeaders['Content-Range'] = contentRange;
        }

        const acceptRanges = response.headers.get('Accept-Ranges');
        if (acceptRanges) {
            responseHeaders['Accept-Ranges'] = acceptRanges;
        }

        // Get audio data
        const audioBuffer = await response.arrayBuffer();
        const audioData = new Uint8Array(audioBuffer);

        log(`Proxied ${audioData.length} bytes`);

        // Return the audio with CORS headers
        return res.send(audioData, response.status, responseHeaders);

    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        error(`Proxy error: ${message}`);

        return res.json({
            success: false,
            error: message,
        }, 500, corsHeaders);
    }
};
