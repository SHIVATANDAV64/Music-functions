/**
 * Manage Playlists Function
 * CRUD operations for user playlists with track management
 *
 * @endpoint POST /manage-playlists
 * @scopes databases.read, databases.write
 */
import { Client, Databases, Query, ID, Permission, Role } from 'node-appwrite';
const DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
export default async ({ req, res, log, error }) => {
    // API key from environment, not from header
    const apiKey = process.env.APPWRITE_API_KEY;
    if (!apiKey) {
        return res.json({ success: false, error: 'API key not configured' }, 500);
    }
    const client = new Client()
        .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
        .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
        .setKey(apiKey);
    const databases = new Databases(client);
    // Get user ID from JWT claims
    const userId = req.headers['x-appwrite-user-id'];
    if (!userId) {
        return res.json({ success: false, error: 'Unauthorized' }, 401);
    }
    try {
        const body = req.body ? JSON.parse(req.body) : {};
        const { action, playlistId, name, description, trackId, trackSource, position } = body;
        log(`Playlist action: ${action} by user: ${userId}`);
        switch (action) {
            case 'create': {
                if (!name?.trim()) {
                    return res.json({ success: false, error: 'Name is required' }, 400);
                }
                const playlist = await databases.createDocument(DATABASE_ID, 'playlists', ID.unique(), {
                    user_id: userId,
                    name: name.trim(),
                    description: description?.trim() || null,
                    is_public: false,
                }, [
                    Permission.read(Role.user(userId)),
                    Permission.update(Role.user(userId)),
                    Permission.delete(Role.user(userId)),
                ]);
                return res.json({ success: true, data: playlist });
            }
            case 'list': {
                const playlists = await databases.listDocuments(DATABASE_ID, 'playlists', [
                    Query.equal('user_id', userId),
                    Query.orderDesc('$createdAt'),
                ]);
                return res.json({ success: true, data: playlists.documents });
            }
            case 'read': {
                if (!playlistId) {
                    return res.json({ success: false, error: 'Playlist ID required' }, 400);
                }
                const playlist = await databases.getDocument(DATABASE_ID, 'playlists', playlistId);
                // Verify ownership or public
                if (playlist.user_id !== userId && !playlist.is_public) {
                    return res.json({ success: false, error: 'Access denied' }, 403);
                }
                // Get tracks from playlist_tracks collection
                const tracksResult = await databases.listDocuments(DATABASE_ID, 'playlist_tracks', [
                    Query.equal('playlist_id', playlistId),
                    Query.orderAsc('position'),
                ]);
                // For Appwrite tracks, we can optionally attach metadata, 
                // but for Jamendo tracks, the frontend will handle retrieval.
                // To keep it consistent with manage-favorites, we'll return the joined data.
                const tracksWithDetails = await Promise.all(tracksResult.documents.map(async (pt) => {
                    try {
                        const track = await databases.getDocument(DATABASE_ID, 'tracks', pt.track_id);
                        // Merge track metadata into the playlist_track record
                        // so it looks like a Track object at the top level
                        return {
                            ...track, // Put track metadata first (title, artist, etc.)
                            $id: track.$id, // Ensure track $id is used
                            pt_id: pt.$id, // Keep the join record ID separate
                            position: pt.position,
                            added_at: pt.added_at,
                            playlist_id: pt.playlist_id
                        };
                    }
                    catch {
                        return pt;
                    }
                }));
                return res.json({
                    success: true,
                    data: { ...playlist, tracks: tracksWithDetails },
                });
            }
            case 'update': {
                if (!playlistId) {
                    return res.json({ success: false, error: 'Playlist ID required' }, 400);
                }
                const updates = {};
                if (name?.trim())
                    updates.name = name.trim();
                if (description !== undefined)
                    updates.description = description?.trim() || null;
                const updated = await databases.updateDocument(DATABASE_ID, 'playlists', playlistId, updates);
                return res.json({ success: true, data: updated });
            }
            case 'delete': {
                if (!playlistId) {
                    return res.json({ success: false, error: 'Playlist ID required' }, 400);
                }
                // Delete playlist tracks first
                const tracks = await databases.listDocuments(DATABASE_ID, 'playlist_tracks', [Query.equal('playlist_id', playlistId)]);
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
                const body = req.body ? JSON.parse(req.body) : {};
                const { metadata } = body;
                // 1. Ensure track exists in tracks collection if it's Jamendo
                if (trackSource === 'jamendo' && metadata) {
                    try {
                        const meta = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
                        const safe = (val, limit) => typeof val === 'string' ? val.substring(0, limit) : val;
                        // Check if already in DB
                        try {
                            await databases.getDocument(DATABASE_ID, 'tracks', trackId);
                        }
                        catch {
                            // Create it
                            log(`[add_track] Ingesting unknown Jamendo track: ${trackId}`);
                            await databases.createDocument(DATABASE_ID, 'tracks', trackId, {
                                title: safe(meta.title, 255),
                                artist: safe(meta.artist, 255),
                                album: safe(meta.album, 255),
                                duration: Number(meta.duration) || 0,
                                source: 'jamendo',
                                jamendo_id: String(meta.jamendo_id || trackId),
                                audio_url: meta.audio_url || null,
                                audio_file_id: meta.audio_file_id || `jamendo_${trackId}`,
                                audio_filename: meta.audio_filename || (meta.title ? `${meta.title.substring(0, 50)}.mp3` : 'track.mp3'),
                                cover_url: meta.cover_url || null,
                                cover_image_id: meta.cover_image_id || `jamendo_cover_${trackId}`,
                                cover_filename: meta.cover_filename || (meta.title ? `${meta.title.substring(0, 50)}_cover.jpg` : 'cover.jpg'),
                                play_count: 0
                            }, [Permission.read(Role.any())]);
                        }
                    }
                    catch (e) {
                        // Propagate error to let frontend know why ingestion failed
                        throw new Error(`Ingestion failed: ${e instanceof Error ? e.message : 'Unknown'}`);
                    }
                }
                // Check for duplicates
                const existing = await databases.listDocuments(DATABASE_ID, 'playlist_tracks', [
                    Query.equal('playlist_id', playlistId),
                    Query.equal('track_id', trackId),
                ]);
                if (existing.documents.length > 0) {
                    return res.json({ success: true, message: 'Track already in playlist', data: existing.documents[0] });
                }
                // Get next position
                const lastTrack = await databases.listDocuments(DATABASE_ID, 'playlist_tracks', [
                    Query.equal('playlist_id', playlistId),
                    Query.orderDesc('position'),
                    Query.limit(1),
                ]);
                const nextPosition = lastTrack.documents.length > 0
                    ? lastTrack.documents[0].position + 1
                    : 0;
                const playlistTrack = await databases.createDocument(DATABASE_ID, 'playlist_tracks', ID.unique(), {
                    playlist_id: playlistId,
                    track_id: trackId,
                    track_source: trackSource || 'jamendo',
                    position: position ?? nextPosition,
                    added_at: new Date().toISOString(),
                }, [
                    Permission.read(Role.user(userId)),
                    Permission.update(Role.user(userId)),
                    Permission.delete(Role.user(userId)),
                ]);
                return res.json({ success: true, data: playlistTrack });
            }
            case 'remove_track': {
                if (!playlistId || !trackId) {
                    return res.json({ success: false, error: 'Playlist ID and Track ID required' }, 400);
                }
                const tracks = await databases.listDocuments(DATABASE_ID, 'playlist_tracks', [
                    Query.equal('playlist_id', playlistId),
                    Query.equal('track_id', trackId),
                ]);
                if (tracks.documents.length === 0) {
                    return res.json({ success: false, error: 'Track not in playlist' }, 404);
                }
                await databases.deleteDocument(DATABASE_ID, 'playlist_tracks', tracks.documents[0].$id);
                return res.json({ success: true });
            }
            default:
                return res.json({ success: false, error: 'Invalid action' }, 400);
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        error(`Playlist operation failed: ${message}`);
        return res.json({ success: false, error: message }, 500);
    }
};
