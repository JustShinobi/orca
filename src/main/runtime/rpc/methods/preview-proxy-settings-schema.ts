import { z } from 'zod'

/** Client-editable previewProxy settings object; the reconciler re-validates
 *  domain/bind before any listener binds. */
export const PreviewProxySettingsUpdate = z
  .object({
    enabled: z.boolean(),
    port: z.number().int().min(1).max(65535),
    domain: z.string().max(512),
    bindHost: z.string().max(256).optional(),
    auth: z.enum(['open', 'token']).optional(),
    token: z.string().max(512).optional()
  })
  .strict()
