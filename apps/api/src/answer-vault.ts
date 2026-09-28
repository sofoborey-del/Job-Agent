import { z } from 'zod';

/** Exact, applicant-approved reusable answers. No form may consume these without a separate gate. */
export const answerTopics = [
  'sexual_orientation',
  'disability_status',
  'ethnicity',
  'gender_identity',
  'religion',
  'marital_status',
  'customer_service_example',
  'handling_sensitive_information_example',
] as const;
export const answerTopicSchema = z.enum(answerTopics);
export type AnswerTopic = z.infer<typeof answerTopicSchema>;

const sensitiveTopics: ReadonlySet<AnswerTopic> = new Set([
  'sexual_orientation', 'disability_status', 'ethnicity', 'gender_identity', 'religion', 'marital_status',
]);

export function answerTopicIsSensitive(topic: AnswerTopic): boolean {
  return sensitiveTopics.has(topic);
}

export function answerTopicFactKey(topic: AnswerTopic): string {
  return `application.answer_vault.${topic}`;
}

export const storedAnswerSchema = z.object({
  topic: answerTopicSchema,
  answer: z.string().trim().min(1).max(3000),
});

/** Plain-English names, so a preparation screen never shows a raw key to the person. */
export const answerTopicLabels: Readonly<Record<AnswerTopic, string>> = {
  sexual_orientation: 'Sexual orientation',
  disability_status: 'Disability status',
  ethnicity: 'Ethnicity',
  gender_identity: 'Gender identity',
  religion: 'Religion or belief',
  marital_status: 'Marital status',
  customer_service_example: 'Customer-service example',
  handling_sensitive_information_example: 'Handling-sensitive-information example',
};
