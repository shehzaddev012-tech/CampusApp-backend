import type { FastifyPluginAsync } from 'fastify';

import type { Deps } from '../app.js';
import type { Guards } from '../auth/guards.js';

export interface RouteOptions {
  deps: Deps;
  guards: Guards;
}

export type Routes = FastifyPluginAsync<RouteOptions>;
