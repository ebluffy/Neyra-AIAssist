import { z } from 'zod'

export const webhookOutboundSchema = z.object({
  enabled: z.boolean(),
  url: z
    .string()
    .trim()
    .regex(/^https?:\/\/.{3,}/i, 'Укажи корректный URL (http:// или https://)'),
  secret: z.string(),
  maxRetries: z
    .number({ error: 'Повторы: целое число от 0 до 10' })
    .int()
    .min(0)
    .max(10, 'Повторы: целое число от 0 до 10'),
  events: z.array(z.string()).min(1, 'Выбери хотя бы одно событие'),
})

export type WebhookOutboundValues = z.infer<typeof webhookOutboundSchema>
