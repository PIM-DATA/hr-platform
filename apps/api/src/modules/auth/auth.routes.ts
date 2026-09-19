import { Router } from 'express';
import { loginSchema } from '@hr/shared';
import { validate } from '../../middleware/validate';
import { requireAuth } from '../../middleware/auth';
import { loginRateLimiter } from '../../middleware/login-rate-limit';
import { authController } from './auth.controller';

export const authRouter = Router();

authRouter.post('/login', loginRateLimiter.check, validate(loginSchema), authController.login);
authRouter.post('/logout', authController.logout); // CSRF enforced globally when a session is present
authRouter.get('/me', requireAuth, authController.me);
