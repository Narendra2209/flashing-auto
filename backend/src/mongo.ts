import { MongoClient, Db, Collection } from 'mongodb';

let clientPromise: Promise<MongoClient> | null = null;

export function isMongoConfigured(): boolean {
  return Boolean(process.env.MONGODB_URI && process.env.MONGODB_URI.trim());
}

export async function getDb(): Promise<Db> {
  if (!isMongoConfigured()) {
    throw new Error(
      'MONGODB_URI not set in backend/.env. Create a free cluster at cloud.mongodb.com → Connect → Drivers, paste the connection string into MONGODB_URI, and restart the backend.'
    );
  }
  if (!clientPromise) {
    const client = new MongoClient(process.env.MONGODB_URI!, {
      // Atlas tolerates these defaults; helpful for first-time setup
      serverSelectionTimeoutMS: 10_000,
      connectTimeoutMS: 10_000
    });
    clientPromise = client.connect();
  }
  const client = await clientPromise;
  return client.db(process.env.MONGODB_DB || 'metfold');
}

export async function getSkuCollection(): Promise<Collection> {
  const db = await getDb();
  const col = db.collection('sku_catalog');
  // Indexes for fast lookup. Created on first call; Mongo no-ops if exists.
  await col.createIndex({ source_file: 1 });
  await col.createIndex({ sku: 1 });
  await col.createIndex({ product_name: 'text', description: 'text' });
  await col.createIndex({ product_name: 1, colour: 1 });
  return col;
}

export async function pingMongo(): Promise<{ ok: boolean; error?: string }> {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}
