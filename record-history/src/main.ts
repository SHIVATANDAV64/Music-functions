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

                // Check for existing entry
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

                return res.json({
                    success: true,
                    data: history.documents,
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
