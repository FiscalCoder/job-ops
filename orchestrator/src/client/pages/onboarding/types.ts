import type { PdfRenderer, ValidationResult } from "@shared/types.js";

export type ValidationState = ValidationResult & {
  checked: boolean;
  hydrated: boolean;
};

export type OnboardingFormData = {
  llmProvider: string;
  llmBaseUrl: string;
  llmApiKey: string;
  model: string;
  llmFallbackEnabled: boolean;
  llmFallbackProvider: string;
  llmFallbackBaseUrl: string;
  llmFallbackModel: string;
  llmFallbackApiKey: string;
  pdfRenderer: PdfRenderer;
  rxresumeUrl: string;
  rxresumeApiKey: string;
  rxresumeBaseResumeId: string | null;
};

export type ResumeSetupMode = "upload" | "rxresume";
