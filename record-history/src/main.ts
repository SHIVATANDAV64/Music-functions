/**
 * Record History Function
 * Track listening history and save resume position
 * 
 * @endpoint POST /record-history
 * @scopes databases.read, databases.write
 */
import { Client, Databases, Query, ID, Permission, Role } from 'node-appwrite';

type Action = 'record' | 'update_position' | 'get_history' | 'get_resume' | 'clear';

interface RequestBody {
    action: Action;
    itemId?: string;
    isEpisode?: boolean;
    position?: number;
    limit?: number;
    metadata?: any; // Full track/episode metadata for ingestion
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
const MAX_HISTORY = 50;

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
        const body: RequestBody = req.body ? JSON.parse(req.body) : {};
        const { action, itemId, isEpisode = false, position = 0, limit = 20 } = body;

        log(`History action: ${action} for user: ${userId}`);

        switch (action) {
            case 'record': {
                if (!itemId) {
                    return res.json({ success: false, error: 'Item ID required' }, 400);
                }

                // Metadata Ingestion Logic
                if (body.metadata && !isEpisode) {
                    const meta = body.metadata;
                    log(`[record] Received metadata for track ${itemId}: title=${meta.title}, artist=${meta.artist}`);

                    // Check if track already exists in our tracks collection
                    try {
                        await databases.getDocument(DATABASE_ID, 'tracks', itemId);
                        log(`[record] Track ${itemId} already exists in DB.`);
                    } catch (e: any) {
                        if (e.code === 404) {
                            log(`[record] Ingesting Jamendo track ${itemId} metadata...`);

                            // Safe truncation for string attributes (default 255 limit)
                            const safe = (val: string | null | undefined, max = 255) => {
                                if (!val) return null;
                                return val.length > max ? val.substring(0, max) : val;
                            };

                            try {
                                const trackData = {
                                    title: safe(meta.title, 255) || 'Unknown',
                                    artist: safe(meta.artist, 255) || 'Unknown',
                                    album: safe(meta.album, 255) || null,
                                    duration: Number(meta.duration) || 0,
                                    source: meta.source || 'jamendo',
                                    jamendo_id: String(meta.jamendo_id || itemId),
                                    audio_url: meta.audio_url || null, // MP3 URLs can be long
                                    audio_file_id: meta.audio_file_id || null,
                                    cover_url: meta.cover_url || null,
                                    cover_image_id: meta.cover_image_id || null,
                                    play_count: 1
                                };

                                log(`[record] Target track data: ${JSON.stringify({
                                    title: trackData.title,
                                    audio_len: trackData.audio_url?.length || 0,
                                    cover_len: trackData.cover_url?.length || 0
                                })}`);

                                await databases.createDocument(
                                    DATABASE_ID,
                                    'tracks',
                                    itemId,
                                    trackData,
                                    [Permission.read(Role.any())]
                                );
                                log(`[record] Successfully created track ${itemId}`);
                            } catch (createErr: any) {
                                error(`[record] Failed to create track ${itemId}: ${createErr.message}`);
                                error(`[record] Error details: ${JSON.stringify(createErr)}`);
                                // If it's a validation error, it's likely attribute size or missing attribute
                                if (createErr.code === 400) {
                                    error(`[record] CHECK YOUR DATABASE: Ensure the 'tracks' collection has all required attributes and string limits are sufficient (e.g., 500+ for URLs).`);
                                }
                            }
                        } else {
                            error(`[record] Error checking track ${itemId}: ${e.message}`);
                        }
                    }
                } else {
                    log(`[record] No metadata provided for ${itemId}, isEpisode=${isEpisode}`);
                }

                // Check for existing history entry
                const existing = await databases.listDocuments(
                    DATABASE_ID,
                    'recently_played',
                    [
                        Query.equal('user_id', userId),
                        isEpisode
                            ? Query.equal('episode_id', itemId)
                            : Query.equal('track_id', itemId),
                        Query.limit(1),
                    ]
                );

                if (existing.documents.length > 0) {
                    // Update existing
                    const updated = await databases.updateDocument(
                        DATABASE_ID,
                        'recently_played',
                        existing.documents[0].$id,
                        {
                            last_position: Math.floor(position),
                            played_at: new Date().toISOString(),
                        }
                    );
                    return res.json({ success: true, data: updated });
                }

                // Create new entry
                const entry = await databases.createDocument(
                    DATABASE_ID,
                    'recently_played',
                    ID.unique(),
                    {
                        user_id: userId,
                        [isEpisode ? 'episode_id' : 'track_id']: itemId,
                        last_position: Math.floor(position),
                        played_at: new Date().toISOString(),
                    },
                    [
                        Permission.read(Role.user(userId)),
                        Permission.update(Role.user(userId)),
                        Permission.delete(Role.user(userId)),
                    ]
                );

                // Cleanup old entries
                await cleanupOldEntries(databases, userId);

                return res.json({ success: true, data: entry });
            }

            case 'update_position': {
                if (!itemId) {
                    return res.json({ success: false, error: 'Item ID required' }, 400);
                }

                const existing = await databases.listDocuments(
                    DATABASE_ID,
                    'recently_played',
                    [
                        Query.equal('user_id', userId),
                        Query.or([
                            Query.equal('track_id', itemId),
                            Query.equal('episode_id', itemId),
                        ]),
                        Query.limit(1),
                    ]
                );

                if (existing.documents.length > 0) {
                    await databases.updateDocument(
                        DATABASE_ID,
                        'recently_played',
                        existing.documents[0].$id,
                        { last_position: Math.floor(position) }
                    );
                }

                return res.json({ success: true });
            }

            case 'get_history': {
                const history = await databases.listDocuments(
                    DATABASE_ID,
                    'recently_played',
                    [
                        Query.equal('user_id', userId),
                        Query.orderDesc('played_at'),
                        Query.limit(Math.min(limit, 50)),
                    ]
                );

                // Inflation Logic: Fetch full track/episode details
                const inflatedHistory = await Promise.all(
                    history.documents.map(async (doc: any) => {
                        try {
                            if (doc.track_id) {
                                const track = await databases.getDocument(DATABASE_ID, 'tracks', doc.track_id);
                                return { ...doc, track };
                            } else if (doc.episode_id) {
                                const episode = await databases.getDocument(DATABASE_ID, 'episodes', doc.episode_id);
                                return { ...doc, episode };
                            }
                        } catch (e: any) {
                            // Log the error but continue - track/episode may have been deleted
                            log(`[get_history] Failed to inflate ${doc.track_id || doc.episode_id}: ${e.message}`);
                        }
                        return doc;
                    })
                );

                return res.json({
                    success: true,
                    data: inflatedHistory,
                    total: history.total,
                });
            }

            case 'get_resume': {
                if (!itemId) {
                    return res.json({ success: false, error: 'Item ID required' }, 400);
                }

                const existing = await databases.listDocuments(
                    DATABASE_ID,
                    'recently_played',
                    [
                        Query.equal('user_id', userId),
                        Query.or([
                            Query.equal('track_id', itemId),
                            Query.equal('episode_id', itemId),
                        ]),
                        Query.limit(1),
                    ]
                );

                const position = existing.documents.length > 0
                    ? (existing.documents[0] as any).last_position
                    : 0;

                return res.json({ success: true, position });
            }

            case 'clear': {
                const history = await databases.listDocuments(
                    DATABASE_ID,
                    'recently_played',
                    [Query.equal('user_id', userId)]
                );

                for (const doc of history.documents) {
                    await databases.deleteDocument(DATABASE_ID, 'recently_played', doc.$id);
                }

                return res.json({ success: true });
            }

            default:
                return res.json({ success: false, error: 'Invalid action' }, 400);
        }

    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        error(`History operation failed: ${message}`);
        return res.json({ success: false, error: message }, 500);
    }
};

async function cleanupOldEntries(databases: Databases, userId: string) {
    const history = await databases.listDocuments(
        DATABASE_ID,
        'recently_played',
        [
            Query.equal('user_id', userId),
            Query.orderDesc('played_at'),
        ]
    );

    if (history.documents.length > MAX_HISTORY) {
        const toDelete = history.documents.slice(MAX_HISTORY);
        for (const doc of toDelete) {
            await databases.deleteDocument(DATABASE_ID, 'recently_played', doc.$id);
        }
    }
}
