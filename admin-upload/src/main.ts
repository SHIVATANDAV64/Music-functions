/**
 * Admin Upload Function
 * Upload tracks and podcasts (admin only)
 * 
 * @endpoint POST /admin-upload
 * @scopes databases.read, databases.write, files.read, files.write
 */
import { Client, Databases, Storage, Query, ID } from 'node-appwrite';

type ContentType = 'track' | 'podcast' | 'episode';

interface TrackData {
    title: string;
    artist: string;
    album?: string;
    genre?: string;
    duration: number;
    audioFileId: string;
    audioFilename?: string;
    coverImageId?: string;
    coverFilename?: string;
}

interface PodcastData {
    title: string;
    author: string;
    description?: string;
    category?: string;
    coverImageId?: string;
}

interface EpisodeData {
    podcastId: string;
    title: string;
    description?: string;
    duration: number;
    audioFileId: string;
    episodeNumber: number;
}

interface RequestBody {
    contentType: ContentType;
    data: TrackData | PodcastData | EpisodeData;
}

interface FunctionContext {
    req: {
        body: string;
        headers: Record<string, string>;
    };
    res: {
        json: (data: unknown, status?: number) => void;
    };
    log: (message: string) => void;
    error: (message: string) => void;
}

const DATABASE_ID = process.env.APPWRITE_DATABASE_ID!;

export default async ({ req, res, log, error }: FunctionContext) => {
    const apiKey = process.env.APPWRITE_API_KEY;
    if (!apiKey) {
        error('Configuration Error: APPWRITE_API_KEY is missing');
        return res.json({ success: false, error: 'API key not configured' }, 500);
    }

    const client = new Client()
        .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT!)
        .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID!)
        .setKey(apiKey);

    const databases = new Databases(client);

    const userId = req.headers['x-appwrite-user-id'];
    if (!userId) {
        error('Authentication Error: Missing x-appwrite-user-id header');
        return res.json({ success: false, error: 'Unauthorized' }, 401);
    }

    try {
        // Verify admin role
        try {
            const user = await databases.getDocument(DATABASE_ID, 'users', userId);
            if (!user.is_admin) {
                error(`Access Denied: User ${userId} is not an admin`);
                return res.json({ success: false, error: 'Admin access required' }, 403);
            }
        } catch (dbError: any) {
            error(`User Verification Failed: ${dbError.message}`);
            return res.json({ success: false, error: 'Failed to verify user permissions' }, 500);
        }

        let body: RequestBody;
        try {
            body = req.body ? JSON.parse(req.body) : {};
        } catch (parseError) {
            error('JSON Parse Error: Failed to parse request body');
            return res.json({ success: false, error: 'Invalid JSON body' }, 400);
        }

        const { contentType, data } = body;
        log(`Starting Admin Upload: Type=${contentType}, User=${userId}`);

        switch (contentType) {
            case 'track': {
                const trackData = data as TrackData;

                // Logging payload for debug (sensitive data omitted if any)
                log(`Track Payload: Title="${trackData.title}", Artist="${trackData.artist}", AudioID=${trackData.audioFileId}, CoverID=${trackData.coverImageId || 'NULL'}`);

                if (!trackData.title?.trim() || !trackData.artist?.trim()) {
                    return res.json({ success: false, error: 'Title and artist required' }, 400);
                }

                if (!trackData.audioFileId) {
                    return res.json({ success: false, error: 'Audio file ID required' }, 400);
                }

                // Construct document object explicitly to avoid 'undefined' issues
                const trackDoc = {
                    title: trackData.title.trim(),
                    artist: trackData.artist.trim(),
                    album: trackData.album?.trim() || null,
                    genre: trackData.genre?.trim() || null,
                    duration: trackData.duration || 0,
                    audio_file_id: trackData.audioFileId,
                    audio_filename: trackData.audioFilename || null,
                    // If coverImageId is missing/null/undefined, we send null. 
                    // CRITICAL: If DB schema requires this, it MUST be provided. 
                    // We interpret "missing attribute" error as this field being null when not allowed.
                    cover_image_id: trackData.coverImageId || null,
                    cover_filename: trackData.coverFilename || null,
                    source: 'appwrite',
                    play_count: 0,
                };

                try {
                    const track = await databases.createDocument(
                        DATABASE_ID,
                        'tracks',
                        ID.unique(),
                        trackDoc
                    );
                    log(`Success: Created track ${track.$id}`);
                    return res.json({ success: true, data: track });
                } catch (dbError: any) {
                    error(`DB Creation Failed (Track): ${dbError.message}`);
                    // Return the specific Appwrite error to help the user debug
                    return res.json({ success: false, error: `Database error: ${dbError.message}` }, 500);
                }
            }

            case 'podcast': {
                const podcastData = data as PodcastData;
                log(`Podcast Payload: Title="${podcastData.title}", Author="${podcastData.author}"`);

                if (!podcastData.title?.trim() || !podcastData.author?.trim()) {
                    return res.json({ success: false, error: 'Title and author required' }, 400);
                }

                try {
                    const podcast = await databases.createDocument(
                        DATABASE_ID,
                        'podcasts',
                        ID.unique(),
                        {
                            title: podcastData.title.trim(),
                            author: podcastData.author.trim(),
                            description: podcastData.description?.trim() || null,
                            category: podcastData.category?.trim() || null,
                            cover_image_id: podcastData.coverImageId || null,
                        }
                    );
                    log(`Success: Created podcast ${podcast.$id}`);
                    return res.json({ success: true, data: podcast });
                } catch (dbError: any) {
                    error(`DB Creation Failed (Podcast): ${dbError.message}`);
                    return res.json({ success: false, error: `Database error: ${dbError.message}` }, 500);
                }
            }

            case 'episode': {
                const episodeData = data as EpisodeData;

                if (!episodeData.podcastId || !episodeData.title?.trim()) {
                    return res.json({ success: false, error: 'Podcast ID and title required' }, 400);
                }

                if (!episodeData.audioFileId) {
                    return res.json({ success: false, error: 'Audio file ID required' }, 400);
                }

                try {
                    await databases.getDocument(DATABASE_ID, 'podcasts', episodeData.podcastId);

                    const episode = await databases.createDocument(
                        DATABASE_ID,
                        'episodes',
                        ID.unique(),
                        {
                            podcast_id: episodeData.podcastId,
                            title: episodeData.title.trim(),
                            description: episodeData.description?.trim() || null,
                            duration: episodeData.duration || 0,
                            audio_file_id: episodeData.audioFileId,
                            episode_number: episodeData.episodeNumber || 1,
                        }
                    );

                    log(`Success: Created episode ${episode.$id}`);
                    return res.json({ success: true, data: episode });
                } catch (dbError: any) {
                    error(`DB Creation Failed (Episode): ${dbError.message}`);
                    return res.json({ success: false, error: `Database error: ${dbError.message}` }, 500);
                }
            }

            default:
                return res.json({ success: false, error: 'Invalid content type' }, 400);
        }

    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        error(`Unhandled Exception: ${message}`);
        return res.json({ success: false, error: `Internal error: ${message}` }, 500);
    }
};
