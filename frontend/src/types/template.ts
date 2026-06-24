export interface BubbleDimensions {
  width: number;
  height: number;
}

export interface FieldBlock {
  fieldType: string;
  origin: [number, number];
  bubblesGap: number;
  labelsGap: number;
  fieldLabels: string[];
  bubbleDimensions?: BubbleDimensions;
}

export interface OmrTemplate {
  id: string;
  name: string;
  pageDimensions: [number, number];
  bubbleDimensions: [number, number];
  fieldBlocks: Record<string, FieldBlock>;
  preProcessors?: Array<{ name: string; options?: Record<string, unknown> }>;
  customLabels?: Record<string, string[]>;
}
