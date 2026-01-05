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
    coverImageId?: string;
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
        return res.json({ success: false, error: 'API key not configured' }, 500);
    }

    const client = new Client()
        .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT!)
        .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID!)
        .setKey(apiKey);

    const databases = new Databases(client);

    const userId = req.headers['x-appwrite-user-id'];
    if (!userId) {
        return res.json({ success: false, error: 'Unauthorized' }, 401);
    }

    try {
        // Verify admin role
        const user = await databases.getDocument(DATABASE_ID, 'users', userId);
        if (!user.is_admin) {
            return res.json({ success: false, error: 'Admin access required' }, 403);
        }

        const body: RequestBody = req.body ? JSON.parse(req.body) : {};
        const { contentType, data } = body;

        log(`Admin upload: ${contentType} by ${userId}`);

        switch (contentType) {
            case 'track': {
                const trackData = data as TrackData;

                if (!trackData.title?.trim() || !trackData.artist?.trim()) {
                    return res.json({ success: false, error: 'Title and artist required' }, 400);
                }

                if (!trackData.audioFileId) {
                    return res.json({ success: false, error: 'Audio file ID required' }, 400);
                }

                const track = await databases.createDocument(
                    DATABASE_ID,
                    'tracks',
                    ID.unique(),
                    {
                        title: trackData.title.trim(),
                        artist: trackData.artist.trim(),
                        album: trackData.album?.trim() || null,
                        genre: trackData.genre?.trim() || null,
                        duration: trackData.duration || 0,
                        audio_file_id: trackData.audioFileId,
                        cover_image_id: trackData.coverImageId || null,
                        play_count: 0,
                    }
                );

                log(`Created track: ${track.$id}`);
                return res.json({ success: true, data: track });
            }

            case 'podcast': {
                const podcastData = data as PodcastData;

                if (!podcastData.title?.trim() || !podcastData.author?.trim()) {
                    return res.json({ success: false, error: 'Title and author required' }, 400);
                }

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

                log(`Created podcast: ${podcast.$id}`);
                return res.json({ success: true, data: podcast });
            }

            case 'episode': {
                const episodeData = data as EpisodeData;

                if (!episodeData.podcastId || !episodeData.title?.trim()) {
                    return res.json({ success: false, error: 'Podcast ID and title required' }, 400);
                }

                if (!episodeData.audioFileId) {
                    return res.json({ success: false, error: 'Audio file ID required' }, 400);
                }

                // Verify podcast exists
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

                log(`Created episode: ${episode.$id}`);
                return res.json({ success: true, data: episode });
            }

            default:
                return res.json({ success: false, error: 'Invalid content type' }, 400);
        }

    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        error(`Admin upload failed: ${message}`);
        return res.json({ success: false, error: message }, 500);
    }
};
