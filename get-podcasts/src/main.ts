/**
 * Get Podcasts Function
 * Fetch podcasts with optional episode loading
 * 
 * @endpoint GET /get-podcasts
 * @scopes databases.read
 */
import { Client, Databases, Query } from 'node-appwrite';

interface RequestBody {
    podcastId?: string;
    category?: string;
    limit?: number;
    offset?: number;
    includeEpisodes?: boolean;
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
        const { podcastId, category, includeEpisodes = false } = body;
        const limit = Math.min(Math.max(1, body.limit ?? 25), 100);
        const offset = Math.max(0, body.offset ?? 0);

        // Fetch single podcast with episodes
        if (podcastId) {
            log(`Fetching podcast: ${podcastId}`);

            const podcast = await databases.getDocument(
                DATABASE_ID,
                'podcasts',
                podcastId
            );

            let episodes: unknown[] = [];
            if (includeEpisodes) {
                const episodesResult = await databases.listDocuments(
                    DATABASE_ID,
                    'episodes',
                    [
                        Query.equal('podcast_id', podcastId),
                        Query.orderDesc('episode_number'),
                        Query.limit(50),
                    ]
                );
                episodes = episodesResult.documents;
            }

            return res.json({
                success: true,
                data: { ...podcast, episodes },
            });
        }

        // Fetch podcast list
        const queries: string[] = [
            Query.limit(limit),
            Query.offset(offset),
            Query.orderDesc('$createdAt'),
        ];

        if (category && typeof category === 'string') {
            queries.push(Query.equal('category', category.trim()));
        }

        const result = await databases.listDocuments(
            DATABASE_ID,
            'podcasts',
            queries
        );

        log(`Found ${result.total} podcasts`);

        return res.json({
            success: true,
            data: result.documents,
            total: result.total,
            hasMore: offset + result.documents.length < result.total,
        });

    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        error(`Failed to fetch podcasts: ${message}`);
        return res.json({ success: false, error: message }, 500);
    }
};
