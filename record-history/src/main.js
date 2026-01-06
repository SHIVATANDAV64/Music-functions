/**
 * Record History Function
 * Track listening history and save resume position
 *
 * @endpoint POST /record-history
 * @scopes databases.read, databases.write
 */
import { Client, Databases, Query, ID, Permission, Role } from 'node-appwrite';
const DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
const MAX_HISTORY = 50;
export default async ({ req, res, log, error }) => {
    const apiKey = process.env.APPWRITE_API_KEY;
    if (!apiKey) {
        return res.json({ success: false, error: 'API key not configured' }, 500);
    }
    const client = new Client()
        .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
        .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
        .setKey(apiKey);
    const databases = new Databases(client);
    const userId = req.headers['x-appwrite-user-id'];
    if (!userId) {
        return res.json({ success: false, error: 'Unauthorized' }, 401);
    }
    try {
        const body = req.body ? JSON.parse(req.body) : {};
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
                    // Check if track already exists in our tracks collection
                    try {
                        await databases.getDocument(DATABASE_ID, 'tracks', itemId);
                        log(`Track ${itemId} already exists in DB.`);
                    }
                    catch (e) {
                        if (e.code === 404) {
                            log(`Ingesting Jamendo track ${itemId} metadata...`);
                            await databases.createDocument(DATABASE_ID, 'tracks', itemId, // Use original ID
                            {
                                title: meta.title,
                                artist: meta.artist,
                                album: meta.album,
                                duration: meta.duration,
                                source: 'jamendo',
                                jamendo_id: meta.jamendo_id || itemId,
                                audio_url: meta.audio_url,
                                audio_file_id: meta.audio_file_id || null,
                                cover_url: meta.cover_url,
                                play_count: 1
                            }, [Permission.read(Role.any())]);
                        }
                    }
                }
                // Check for existing history entry
                const existing = await databases.listDocuments(DATABASE_ID, 'recently_played', [
                    Query.equal('user_id', userId),
                    isEpisode
                        ? Query.equal('episode_id', itemId)
                        : Query.equal('track_id', itemId),
                    Query.limit(1),
                ]);
                if (existing.documents.length > 0) {
                    // Update existing
                    const updated = await databases.updateDocument(DATABASE_ID, 'recently_played', existing.documents[0].$id, {
                        last_position: Math.floor(position),
                        played_at: new Date().toISOString(),
                    });
                    return res.json({ success: true, data: updated });
                }
                // Create new entry
                const entry = await databases.createDocument(DATABASE_ID, 'recently_played', ID.unique(), {
                    user_id: userId,
                    [isEpisode ? 'episode_id' : 'track_id']: itemId,
                    last_position: Math.floor(position),
                    played_at: new Date().toISOString(),
                }, [
                    Permission.read(Role.user(userId)),
                    Permission.update(Role.user(userId)),
                    Permission.delete(Role.user(userId)),
                ]);
                // Cleanup old entries
                await cleanupOldEntries(databases, userId);
                return res.json({ success: true, data: entry });
            }
            case 'update_position': {
                if (!itemId) {
                    return res.json({ success: false, error: 'Item ID required' }, 400);
                }
                const existing = await databases.listDocuments(DATABASE_ID, 'recently_played', [
                    Query.equal('user_id', userId),
                    Query.or([
                        Query.equal('track_id', itemId),
                        Query.equal('episode_id', itemId),
                    ]),
                    Query.limit(1),
                ]);
                if (existing.documents.length > 0) {
                    await databases.updateDocument(DATABASE_ID, 'recently_played', existing.documents[0].$id, { last_position: Math.floor(position) });
                }
                return res.json({ success: true });
            }
            case 'get_history': {
                const history = await databases.listDocuments(DATABASE_ID, 'recently_played', [
                    Query.equal('user_id', userId),
                    Query.orderDesc('played_at'),
                    Query.limit(Math.min(limit, 50)),
                ]);
                // Inflation Logic: Fetch full track/episode details
                const inflatedHistory = await Promise.all(history.documents.map(async (doc) => {
                    try {
                        if (doc.track_id) {
                            const track = await databases.getDocument(DATABASE_ID, 'tracks', doc.track_id);
                            return { ...doc, track };
                        }
                        else if (doc.episode_id) {
                            const episode = await databases.getDocument(DATABASE_ID, 'episodes', doc.episode_id);
                            return { ...doc, episode };
                        }
                    }
                    catch (e) {
                        // If details missing, return base doc
                    }
                    return doc;
                }));
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
                const existing = await databases.listDocuments(DATABASE_ID, 'recently_played', [
                    Query.equal('user_id', userId),
                    Query.or([
                        Query.equal('track_id', itemId),
                        Query.equal('episode_id', itemId),
                    ]),
                    Query.limit(1),
                ]);
                const position = existing.documents.length > 0
                    ? existing.documents[0].last_position
                    : 0;
                return res.json({ success: true, position });
            }
            case 'clear': {
                const history = await databases.listDocuments(DATABASE_ID, 'recently_played', [Query.equal('user_id', userId)]);
                for (const doc of history.documents) {
                    await databases.deleteDocument(DATABASE_ID, 'recently_played', doc.$id);
                }
                return res.json({ success: true });
            }
            default:
                return res.json({ success: false, error: 'Invalid action' }, 400);
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        error(`History operation failed: ${message}`);
        return res.json({ success: false, error: message }, 500);
    }
};
async function cleanupOldEntries(databases, userId) {
    const history = await databases.listDocuments(DATABASE_ID, 'recently_played', [
        Query.equal('user_id', userId),
        Query.orderDesc('played_at'),
    ]);
    if (history.documents.length > MAX_HISTORY) {
        const toDelete = history.documents.slice(MAX_HISTORY);
        for (const doc of toDelete) {
            await databases.deleteDocument(DATABASE_ID, 'recently_played', doc.$id);
        }
    }
}
