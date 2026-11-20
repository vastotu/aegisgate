export { AEGIS_HEADERS, type CheckRateLimitResponse } from '@aegisgate/shared';
export {
  AegisGateClient,
  toAegisHeaders,
  type AegisGateConfig,
  type CheckParams,
  type FrameCheckResult,
} from './client';
export {
  createExpressMiddleware,
  createFastifyHook,
  withAegisGateNextHandler,
  type AegisMiddlewareConfig,
  type ExpressLikeNext,
  type ExpressLikeRequest,
  type ExpressLikeResponse,
  type FastifyLikeReply,
  type FastifyLikeRequest,
} from './middleware';
