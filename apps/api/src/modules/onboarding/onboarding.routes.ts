import { Router, type Response } from 'express';
import { ONBOARDING_LIMITS, PERMISSIONS, onboardingCommitSchema, onboardingImportListQuerySchema } from '@hr/shared';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { singleFileUpload } from '../../middleware/upload';
import { AppError } from '../../lib/errors';
import { requestMeta } from '../../services/audit/audit.service';
import { onboardingService } from './onboarding.service';
import { buildTemplate } from './workbook';

/**
 * Customer onboarding: download a template, preview a filled workbook, then commit it.
 *
 * Everything needs `onboarding.manage` (HR_ADMIN and SYSTEM_ADMIN) because an import creates organizations,
 * departments, jobs, positions and employees in one go. Preview writes nothing; commit is all-or-nothing.
 */
export const onboardingRouter = Router();
onboardingRouter.use(requireAuth, requirePermission(PERMISSIONS.ONBOARDING_MANAGE));

const actor = (req: Parameters<typeof requestMeta>[0]) => ({ auth: req.auth!, ...requestMeta(req) });
const upload = singleFileUpload({ maxBytes: ONBOARDING_LIMITS.maxFileBytes, field: 'file', extensions: ['.xlsx'] });

onboardingRouter.get('/template', async (_req, res) => {
  const buffer = await buildTemplate();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="hr-onboarding-template.xlsx"');
  res.setHeader('Content-Length', String(buffer.length));
  res.end(buffer);
});

onboardingRouter.post('/preview', upload, async (req, res) => {
  const file = req.uploadedFile!;
  res.json({ data: await onboardingService.preview(file.buffer, file.fileName, actor(req)) });
});

onboardingRouter.post('/commit', upload, async (req, res) => {
  const file = req.uploadedFile!;
  const parsed = onboardingCommitSchema.safeParse(req.uploadedFields ?? {});
  if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'expectedSha256 is required and must be the digest returned by preview');
  res.json({ data: await onboardingService.commit(file.buffer, file.fileName, parsed.data.expectedSha256, actor(req)) });
});

onboardingRouter.get('/imports', validate(onboardingImportListQuerySchema, 'query'), async (_req, res: Response) => res.json(await onboardingService.listImports(res.locals.query)));
