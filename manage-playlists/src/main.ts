/**
 * Manage Playlists Function
 * CRUD operations for user playlists with track management
 * 
 * @endpoint POST /manage-playlists
 * @scopes databases.read, databases.write
 */
import { Client, Databases, Query, ID, Permission, Role } from 'node-appwrite';

type Action = 'create' | 'read' | 'update' | 'delete' | 'add_track' | 'remove_track' | 'list';

interface RequestBody {
    action: Action;
    playlistId?: string;
    name?: string;
    description?: string;
    trackId?: string;
    trackSource?: 'jamendo' | 'appwrite';
    position?: number;
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
    // API key from environment, not from header
    const apiKey = process.env.APPWRITE_API_KEY;
    if (!apiKey) {
        return res.json({ success: false, error: 'API key not configured' }, 500);
    }

    const client = new Client()
        .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT!)
        .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID!)
        .setKey(apiKey);

    const databases = new Databases(client);

    // Get user ID from JWT claims
    const userId = req.headers['x-appwrite-user-id'];
    if (!userId) {
        return res.json({ success: false, error: 'Unauthorized' }, 401);
    }

    try {
        const body: RequestBody = req.body ? JSON.parse(req.body) : {};
        const { action, playlistId, name, description, trackId, trackSource, position } = body;

        log(`Playlist action: ${action} by user: ${userId}`);

        switch (action) {
            case 'create': {
                if (!name?.trim()) {
                    return res.json({ success: false, error: 'Name is required' }, 400);
                }

                const playlist = await databases.createDocument(
                    DATABASE_ID,
                    'playlists',
                    ID.unique(),
                    {
                        user_id: userId,
                        name: name.trim(),
                        description: description?.trim() || null,
                        is_public: false,
                    },
                    [
                        Permission.read(Role.user(userId)),
                        Permission.update(Role.user(userId)),
                        Permission.delete(Role.user(userId)),
                    ]
                );

                return res.json({ success: true, data: playlist });
            }

            case 'list': {
                const playlists = await databases.listDocuments(
                    DATABASE_ID,
                    'playlists',
                    [
                        Query.equal('user_id', userId),
                        Query.orderDesc('$createdAt'),
                    ]
                );
                return res.json({ success: true, data: playlists.documents });
            }

            case 'read': {
                if (!playlistId) {
                    return res.json({ success: false, error: 'Playlist ID required' }, 400);
                }

                const playlist = await databases.getDocument(
                    DATABASE_ID,
                    'playlists',
                    playlistId
                );

                // Verify ownership or public
                if (playlist.user_id !== userId && !playlist.is_public) {
                    return res.json({ success: false, error: 'Access denied' }, 403);
                }

                // Get tracks from playlist_tracks collection
                const tracksResult = await databases.listDocuments(
                    DATABASE_ID,
                    'playlist_tracks',
                    [
                        Query.equal('playlist_id', playlistId),
                        Query.orderAsc('position'),
                    ]
                );

                // For Appwrite tracks, we can optionally attach metadata, 
                // but for Jamendo tracks, the frontend will handle retrieval.
                // To keep it consistent with manage-favorites, we'll return the joined data.
                const tracksWithDetails = await Promise.all(
                    tracksResult.documents.map(async (pt: any) => {
                        if (pt.track_source === 'appwrite') {
                            try {
                                const track = await databases.getDocument(
                                    DATABASE_ID,
                                    'tracks',
                                    pt.track_id
                                );
                                return { ...pt, track };
                            } catch {
                                return pt;
                            }
                        }
                        return pt;
                    })
                );

                return res.json({
                    success: true,
                    data: { ...playlist, tracks: tracksWithDetails },
                });
            }

            case 'update': {
                if (!playlistId) {
                    return res.json({ success: false, error: 'Playlist ID required' }, 400);
                }

                const updates: Record<string, unknown> = {};
                if (name?.trim()) updates.name = name.trim();
                if (description !== undefined) updates.description = description?.trim() || null;

                const updated = await databases.updateDocument(
                    DATABASE_ID,
                    'playlists',
                    playlistId,
                    updates
                );

                return res.json({ success: true, data: updated });
            }

            case 'delete': {
                if (!playlistId) {
                    return res.json({ success: false, error: 'Playlist ID required' }, 400);
                }

                // Delete playlist tracks first
                const tracks = await databases.listDocuments(
                    DATABASE_ID,
                    'playlist_tracks',
                    [Query.equal('playlist_id', playlistId)]
                );

                for (const track of tracks.documents) {
                    await databases.deleteDocument(DATABASE_ID, 'playlist_tracks', track.$id);
                }

                await databases.deleteDocument(DATABASE_ID, 'playlists', playlistId);
                return res.json({ success: true });
            }

            case 'add_track': {
                if (!playlistId || !trackId) {
                    return res.json({ success: false, error: 'Playlist ID and Track ID required' }, 400);
                }

                // Check for duplicates
                const existing = await databases.listDocuments(
                    DATABASE_ID,
                    'playlist_tracks',
                    [
                        Query.equal('playlist_id', playlistId),
                        Query.equal('track_id', trackId),
                    ]
                );

                if (existing.documents.length > 0) {
                    return res.json({ success: false, error: 'Track already in playlist' }, 409);
                }

                // Get next position
                const lastTrack = await databases.listDocuments(
                    DATABASE_ID,
                    'playlist_tracks',
                    [
                        Query.equal('playlist_id', playlistId),
                        Query.orderDesc('position'),
                        Query.limit(1),
                    ]
                );

                const nextPosition = lastTrack.documents.length > 0
                    ? (lastTrack.documents[0] as any).position + 1
                    : 0;

                const playlistTrack = await databases.createDocument(
                    DATABASE_ID,
                    'playlist_tracks',
                    ID.unique(),
                    {
                        playlist_id: playlistId,
                        track_id: trackId,
                        track_source: trackSource || 'jamendo',
                        position: position ?? nextPosition,
                        added_at: new Date().toISOString(),
                    },
                    [
                        Permission.read(Role.user(userId)),
                        Permission.update(Role.user(userId)),
                        Permission.delete(Role.user(userId)),
                    ]
                );

                return res.json({ success: true, data: playlistTrack });
            }

            case 'remove_track': {
                if (!playlistId || !trackId) {
                    return res.json({ success: false, error: 'Playlist ID and Track ID required' }, 400);
                }

                const tracks = await databases.listDocuments(
                    DATABASE_ID,
                    'playlist_tracks',
                    [
                        Query.equal('playlist_id', playlistId),
                        Query.equal('track_id', trackId),
                    ]
                );

                if (tracks.documents.length === 0) {
                    return res.json({ success: false, error: 'Track not in playlist' }, 404);
                }

                await databases.deleteDocument(
                    DATABASE_ID,
                    'playlist_tracks',
                    tracks.documents[0].$id
                );

                return res.json({ success: true });
            }

            default:
                return res.json({ success: false, error: 'Invalid action' }, 400);
        }

    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        error(`Playlist operation failed: ${message}`);
        return res.json({ success: false, error: message }, 500);
    }
};
