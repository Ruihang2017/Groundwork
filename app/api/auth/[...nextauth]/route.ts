import { handlers } from '@/auth';

// Auth.js v5's route-handler convention (confirmed against the installed
// next-auth@5.0.0-beta.31 / authjs.dev next.js installation docs): re-export the
// framework-generated GET/POST handlers. This endpoint MUST stay reachable
// unauthenticated — middleware.ts's matcher excludes /api/** for exactly this.
export const { GET, POST } = handlers;
