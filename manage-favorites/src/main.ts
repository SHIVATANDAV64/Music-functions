/**
 * Manage Favorites Function
 * Add/remove/toggle favorites for tracks
 * 
 * @endpoint POST /manage-favorites
 * @scopes databases.read, databases.write
 */
import { Client, Databases, Query, ID, Permission, Role } from 'node-appwrite';

type Action = 'add' | 'remove' | 'toggle' | 'list' | 'check' | 'get_ids';

interface RequestBody {
    action: Action;
    trackId?: string;
    trackSource?: 'jamendo' | 'appwrite';
    limit?: number;
    offset?: number;
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

const DATABASE_ID = 'music_db';

export default async ({ req, res, log, error }: FunctionContext) => {
    const client = new Client()
        .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT!)
        .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID!)
        .setKey(req.headers['x-appwrite-key']);

    const databases = new Databases(client);

    const userId = req.headers['x-appwrite-user-id'];
    if (!userId) {
        return res.json({ success: false, error: 'Unauthorized' }, 401);
    }

    try {
        const body: RequestBody = req.body ? JSON.parse(req.body) : {};
        const { action, trackId, trackSource = 'jamendo', limit = 50, offset = 0 } = body;

        log(`Favorites action: ${action} by user: ${userId}`);

        switch (action) {
            case 'check': {
                if (!trackId) {
                    return res.json({ success: false, error: 'Track ID required' }, 400);
                }

                const existing = await databases.listDocuments(
                    DATABASE_ID,
                    'favorites',
                    [
                        Query.equal('user_id', userId),
                        Query.equal('track_id', trackId),
                        Query.limit(1),
                    ]
                );

                return res.json({
                    success: true,
                    isFavorite: existing.total > 0,
                });
            }

            case 'add': {
                if (!trackId) {
                    return res.json({ success: false, error: 'Track ID required' }, 400);
                }

                // Check if already favorited
                const existing = await databases.listDocuments(
                    DATABASE_ID,
                    'favorites',
                    [
                        Query.equal('user_id', userId),
                        Query.equal('track_id', trackId),
                        Query.limit(1),
                    ]
                );

                if (existing.total > 0) {
                    return res.json({ success: true, alreadyExists: true });
                }

                const favorite = await databases.createDocument(
                    DATABASE_ID,
                    'favorites',
                    ID.unique(),
                    {
                        user_id: userId,
                        track_id: trackId,
                        track_source: trackSource,
                    },
                    [
                        Permission.read(Role.user(userId)),
                        Permission.delete(Role.user(userId)),
                    ]
                );

                return res.json({ success: true, data: favorite });
            }

            case 'remove': {
                if (!trackId) {
                    return res.json({ success: false, error: 'Track ID required' }, 400);
                }

                const existing = await databases.listDocuments(
                    DATABASE_ID,
                    'favorites',
                    [
                        Query.equal('user_id', userId),
                        Query.equal('track_id', trackId),
                    ]
                );

                if (existing.documents.length > 0) {
                    await databases.deleteDocument(
                        DATABASE_ID,
                        'favorites',
                        existing.documents[0].$id
                    );
                }

                return res.json({ success: true });
            }

            case 'toggle': {
                if (!trackId) {
                    return res.json({ success: false, error: 'Track ID required' }, 400);
                }

                const existing = await databases.listDocuments(
                    DATABASE_ID,
                    'favorites',
                    [
                        Query.equal('user_id', userId),
                        Query.equal('track_id', trackId),
                        Query.limit(1),
                    ]
                );

                if (existing.total > 0) {
                    // Remove favorite
                    await databases.deleteDocument(
                        DATABASE_ID,
                        'favorites',
                        existing.documents[0].$id
                    );
                    return res.json({ success: true, isFavorite: false });
                } else {
                    // Add favorite
                    await databases.createDocument(
                        DATABASE_ID,
                        'favorites',
                        ID.unique(),
                        {
                            user_id: userId,
                            track_id: trackId,
                            track_source: trackSource,
                        },
                        [
                            Permission.read(Role.user(userId)),
                            Permission.delete(Role.user(userId)),
                        ]
                    );
                    return res.json({ success: true, isFavorite: true });
                }
            }

            case 'list': {
                const favorites = await databases.listDocuments(
                    DATABASE_ID,
                    'favorites',
                    [
                        Query.equal('user_id', userId),
                        Query.orderDesc('$createdAt'),
                        Query.limit(Math.min(limit, 100)),
                        Query.offset(offset),
                    ]
                );

                // Fetch Appwrite track details for non-Jamendo tracks
                const tracksWithDetails = await Promise.all(
                    favorites.documents.map(async (fav: any) => {
                        if (fav.track_source === 'appwrite') {
                            try {
                                const track = await databases.getDocument(
                                    DATABASE_ID,
                                    'tracks',
                                    fav.track_id
                                );
                                return { ...fav, track };
                            } catch {
                                return fav;
                            }
                        }
                        return fav;
                    })
                );

                return res.json({
                    success: true,
                    data: tracksWithDetails,
                    total: favorites.total,
                    hasMore: offset + favorites.documents.length < favorites.total,
                });
            }

            case 'get_ids': {
                const favorites = await databases.listDocuments(
                    DATABASE_ID,
                    'favorites',
                    [
                        Query.equal('user_id', userId),
                        Query.select(['track_id']),
                        Query.limit(500),
                    ]
                );

                const ids = favorites.documents.map((f: any) => f.track_id);

                return res.json({
                    success: true,
                    ids,
                    total: favorites.total,
                });
            }

            default:
                return res.json({ success: false, error: 'Invalid action' }, 400);
        }

    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        error(`Favorites operation failed: ${message}`);
        return res.json({ success: false, error: message }, 500);
    }
};
