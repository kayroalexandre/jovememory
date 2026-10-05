import { bucket, defineRailway, github, image, preserve, project, service, volume } from 'railway/iac';

// Import/reconcile an already provisioned installation; private values stay on Railway.
export default defineRailway(() => {
  const data = volume('pgvector-volume', { region: 'us-west2', sizeMB: 5000 });
  const media = bucket('Media', { region: 'iad' });
  const db = service('pgvector', {
    source: image('pgvector/pgvector@sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d'),
    replicas: { 'us-west2': 1 },
    volumeMounts: { '/var/lib/postgresql/data': data },
    env: {
      POSTGRES_USER: 'postgres', POSTGRES_DB: 'jovememory', POSTGRES_PASSWORD: preserve(),
      PGDATA: '/var/lib/postgresql/data/pgdata', RAILWAY_RUN_UID: '0',
      PGDATABASE: '${{POSTGRES_DB}}', PGUSER: '${{POSTGRES_USER}}', PGPASSWORD: '${{POSTGRES_PASSWORD}}',
      PGHOST: '${{RAILWAY_PRIVATE_DOMAIN}}', PGHOST_PRIVATE: '${{RAILWAY_PRIVATE_DOMAIN}}',
      PGPORT: '5432', PGPORT_PRIVATE: '5432',
      DATABASE_URL_PRIVATE: preserve(),
      DATABASE_URL: '${{DATABASE_URL_PRIVATE}}',
    },
  });
  const app = service('jovememory', {
    source: github('kayroalexandre/jovememory', { branch: 'main' }),
    build: { builder: 'RAILPACK', buildCommand: 'npm ci --omit=dev' },
    start: 'npm start', preDeploy: 'npm run migrate',
    healthcheck: '/health', healthcheckTimeout: 120,
    replicas: { 'us-west2': 1 },
    deploy: { restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 5, drainingSeconds: 20 },
    env: {
      NODE_ENV: 'production', HOST: '0.0.0.0', PORT: '3000',
      PUBLIC_URL: 'https://${{RAILWAY_PUBLIC_DOMAIN}}',
      MIGRATION_DATABASE_URL: db.env.DATABASE_URL_PRIVATE,
      AUTH_PROFILES: preserve(), EXTRA_AUTH_PROFILES: preserve(), ENABLE_PROVIDER: preserve(), MEMORY_REVIEW_MODE: 'automatic',
      OPENROUTER_API_KEY: preserve(), OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
      OPENROUTER_DECISIONS_URL: 'https://openrouter.ai/api/alpha/decisions',
      EMBEDDING_MODEL: 'google/gemini-embedding-2', EMBEDDING_DIMENSIONS: '1536',
      DECISION_MODEL: 'upstage/solar-decide', RERANK_MODEL: 'qwen/qwen3.8-flash',
      KNOWLEDGE_MODEL: 'deepseek/deepseek-v4-flash', SYNTHESIS_MODEL: 'openrouter/free',
      FREE_INFERENCE_PREFERENCES: 'nvidia/nemotron-3-ultra-550b-a55b:free,nvidia/nemotron-3-super-120b-a12b:free,google/gemma-4-31b-it:free',
      INFERENCE_FALLBACK_MODELS: 'deepseek/deepseek-v4-pro,deepseek/deepseek-v4-flash,xiaomi/mimo-v2.5',
      INFERENCE_MAX_INPUT_PRICE: '0.25', INFERENCE_MAX_OUTPUT_PRICE: '1.50',
      S3_ENDPOINT: '${{Media.ENDPOINT}}', S3_BUCKET: '${{Media.BUCKET}}', S3_REGION: 'auto',
      S3_ACCESS_KEY_ID: '${{Media.ACCESS_KEY_ID}}', S3_SECRET_ACCESS_KEY: '${{Media.SECRET_ACCESS_KEY}}',
    },
  });
  return project('jovememory', { resources: [app, db, data, media] });
});
