export type EvidenceItem = {
  code: string;
  pattern: string | null;
  weight: number;
  text: string;
  via: string | null;
  /** Transaction ids in the detected cluster (windowed patterns only; absent on older alerts). */
  members?: string[];
};
