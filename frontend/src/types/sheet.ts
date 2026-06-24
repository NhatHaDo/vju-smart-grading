export type SheetStatus = 'pending' | 'processing' | 'graded' | 'needs_review' | 'error';

export interface Sheet {
  id: number;
  examId: number;
  studentId?: string;   // SBD
  studentName?: string;
  imageUrl?: string;
  checkedImageUrl?: string;
  status: SheetStatus;
  needsReview: boolean;
  alignmentWarning?: string;
  createdAt: string;
}

export interface ManualCorrection {
  sheetId: number;
  field: string;
  originalValue: string;
  correctedValue: string;
  correctedBy: number;
  correctedAt: string;
}
