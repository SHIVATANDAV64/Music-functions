/**
 * Search Function
 * Full-text search across tracks, podcasts, and artists
 * 
 * @endpoint POST /search
 * @scopes databases.read
 */
import { Client, Databases, Query } from 'node-appwrite';

interface RequestBody {
    query: string;
    types?: ('tracks' | 'podcasts' | 'episodes')[];
    limit?: number;
}

interface SearchResults {
    tracks: unknown[];
    podcasts: unknown[];
    episodes: unknown[];
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

    try {
        const body: RequestBody = req.body ? JSON.parse(req.body) : {};
        const { query, types = ['tracks', 'podcasts', 'episodes'], limit = 10 } = body;

        // Validate search query
        const searchTerm = query?.trim();
        if (!searchTerm || searchTerm.length < 2) {
            return res.json({
                success: false,
                error: 'Search query must be at least 2 characters',
            }, 400);
        }

        log(`Searching for: "${searchTerm}" in ${types.join(', ')}`);

        const results: SearchResults = {
            tracks: [],
            podcasts: [],
            episodes: [],
        };

        const searchLimit = Math.min(Math.max(1, limit), 25);

        // Search tracks (parallel)
        const searchPromises: Promise<void>[] = [];

        if (types.includes('tracks')) {
            searchPromises.push(
                databases.listDocuments(DATABASE_ID, 'tracks', [
                    Query.search('title', searchTerm),
                    Query.limit(searchLimit),
                ]).then(res => {
                    results.tracks = res.documents;
                }).catch(() => {
                    // Fallback: search by artist if title search fails
                    return databases.listDocuments(DATABASE_ID, 'tracks', [
                        Query.contains('artist', searchTerm),
                        Query.limit(searchLimit),
                    ]).then(res => {
                        results.tracks = res.documents;
                    });
                })
            );
        }

        if (types.includes('podcasts')) {
            searchPromises.push(
                databases.listDocuments(DATABASE_ID, 'podcasts', [
                    Query.search('title', searchTerm),
                    Query.limit(searchLimit),
                ]).then(res => {
                    results.podcasts = res.documents;
                }).catch(() => { })
            );
        }

        if (types.includes('episodes')) {
            searchPromises.push(
                databases.listDocuments(DATABASE_ID, 'episodes', [
                    Query.search('title', searchTerm),
                    Query.limit(searchLimit),
                ]).then(res => {
                    results.episodes = res.documents;
                }).catch(() => { })
            );
        }

        // Execute all searches in parallel
        await Promise.all(searchPromises);

        const totalResults =
            results.tracks.length +
            results.podcasts.length +
            results.episodes.length;

        log(`Found ${totalResults} results`);

        return res.json({
            success: true,
            query: searchTerm,
            results,
            total: totalResults,
        });

    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        error(`Search failed: ${message}`);
        return res.json({ success: false, error: message }, 500);
    }
};
