import type { AuthContext } from '../modules/auth/auth.types';

declare global {
  namespace Express {
    interface Request {
      /** Set by `authenticate` when the request carries a valid session; undefined otherwise. */
      auth?: AuthContext;
    }
  }
}
export {};
