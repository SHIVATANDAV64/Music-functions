/**
 * Get Tracks Function
 * Fetch music tracks with filtering, pagination, and search
 * 
 * @endpoint GET /get-tracks
 * @scopes databases.read
 */
import { Client, Databases, Query } from 'node-appwrite';

interface RequestBody {
    genre?: string;
    limit?: number;
    offset?: number;
    search?: string;
    sortBy?: 'createdAt' | 'playCount' | 'title';
    sortOrder?: 'asc' | 'desc';
}

interface FunctionContext {
    req: {
        body: string;
        headers: Record<string, string>;
        method: string;
        path: string;
    };
    res: {
        json: (data: unknown, status?: number) => void;
        text: (data: string, status?: number) => void;
    };
    log: (message: string) => void;
    error: (message: string) => void;
}

const DATABASE_ID = process.env.APPWRITE_DATABASE_ID!;
const COLLECTION_ID = 'tracks';

export default async ({ req, res, log, error }: FunctionContext) => {
    const apiKey = process.env.APPWRITE_API_KEY;
    if (!apiKey) {
        return res.json({ success: false, error: 'API key not configured' }, 500);
    }

    // Initialize Appwrite client with API key from environment
    const client = new Client()
        .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT!)
        .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID!)
        .setKey(apiKey);

    const databases = new Databases(client);

    // Validate user authentication
    const userId = req.headers['x-appwrite-user-id'];
    if (!userId) {
        return res.json({ success: false, error: 'Authentication required' }, 401);
    }

    try {
        // Parse request body with validation
        const body: RequestBody = req.body ? JSON.parse(req.body) : {};

        // Validate and sanitize inputs
        const limit = Math.min(Math.max(1, body.limit ?? 25), 100);
        const offset = Math.max(0, body.offset ?? 0);
        const genre = typeof body.genre === 'string' ? body.genre.trim() : undefined;
        const search = typeof body.search === 'string' ? body.search.trim() : undefined;
        const sortBy = body.sortBy ?? 'createdAt';
        const sortOrder = body.sortOrder ?? 'desc';

        log(`Fetching tracks: limit=${limit}, offset=${offset}, genre=${genre}, search=${search}`);

        // Build query array
        const queries: string[] = [
            Query.limit(limit),
            Query.offset(offset),
        ];

        // Add genre filter if provided
        if (genre) {
            queries.push(Query.equal('genre', genre));
        }

        // Add search if provided (requires fulltext index on 'title')
        if (search && search.length >= 2) {
            queries.push(Query.search('title', search));
        }

        // Add sorting
        if (sortBy === 'playCount') {
            sortOrder === 'desc'
                ? queries.push(Query.orderDesc('play_count'))
                : queries.push(Query.orderAsc('play_count'));
        } else if (sortBy === 'title') {
            sortOrder === 'desc'
                ? queries.push(Query.orderDesc('title'))
                : queries.push(Query.orderAsc('title'));
        } else {
            sortOrder === 'desc'
                ? queries.push(Query.orderDesc('$createdAt'))
                : queries.push(Query.orderAsc('$createdAt'));
        }

        // Execute query
        const result = await databases.listDocuments(
            DATABASE_ID,
            COLLECTION_ID,
            queries
        );

        log(`Found ${result.total} tracks, returning ${result.documents.length}`);

        return res.json({
            success: true,
            data: result.documents,
            total: result.total,
            limit,
            offset,
            hasMore: offset + result.documents.length < result.total,
        });

    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        error(`Failed to fetch tracks: ${message}`);

        return res.json({
            success: false,
            error: message,
        }, 500);
    }
};
