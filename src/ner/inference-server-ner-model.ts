/**
 * Inference Server NER Model
 * NER model using remote GPU inference with server-side tokenization
 */

import { SpanMatch, AnonymizationPolicy, DetectionSource, PIIType } from "../types/index.js";
import {
  InferenceServerClient,
  type ServerEntityMatch,
} from "./inference-server-client.js";
import type { INERModel, NERPrediction } from "./ner-model.js";

/**
 * Configuration
 */
export interface InferenceServerNERModelConfig {
  /** Server URL (e.g., 'http://localhost:8080') */
  serverUrl: string;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /** Model version string */
  modelVersion?: string;
  /** Status callback */
  onStatus?: (message: string) => void;
}

// Server type → SDK PIIType mapping
const SERVER_TYPE_TO_PII_TYPE: Record<string, PIIType> = {
  'PERSON': PIIType.PERSON,
  'PER': PIIType.PERSON,
  'ORG': PIIType.ORG,
  'ORGANIZATION': PIIType.ORG,
  'LOCATION': PIIType.LOCATION,
  'LOC': PIIType.LOCATION,
  'GPE': PIIType.LOCATION,
};

/**
 * NER Model that delegates to a GPU inference server.
 * 
 * Server handles: tokenization, inference, BIO decoding, span cleanup
 * Client handles: type mapping, policy filtering
 */
export class InferenceServerNERModel implements INERModel {
  private client: InferenceServerClient;
  private config: InferenceServerNERModelConfig;
  private isLoaded = false;
  readonly version: string;
  /** 归因标识：记录里用它区分模型命中与规则命中。 */
  readonly recognizerId: string;

  constructor(config: InferenceServerNERModelConfig) {
    this.config = config;
    this.version = config.modelVersion ?? "2.0.0";
    this.recognizerId = `ner:${this.version}`;
    this.client = new InferenceServerClient({
      url: config.serverUrl,
      timeout: config.timeout,
    });
  }

  get loaded(): boolean {
    return this.isLoaded;
  }

  async load(): Promise<void> {
    if (this.isLoaded) return;

    this.config.onStatus?.("Connecting to inference server...");

    try {
      const health = await this.client.health();
      
      if (!health.model_loaded) {
        this.config.onStatus?.("Waiting for server to load model...");
        await this.client.waitUntilReady();
      }
      
      this.config.onStatus?.(`Connected (${health.provider})`);
    } catch (error) {
      throw new Error(
        `Failed to connect to ${this.config.serverUrl}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    this.isLoaded = true;
    this.config.onStatus?.("Ready");
  }

  async predict(text: string, policy?: AnonymizationPolicy): Promise<NERPrediction> {
    if (!this.isLoaded) {
      throw new Error("Model not loaded. Call load() first.");
    }

    const minConfidence = this.getMinConfidence(policy);
    const result = await this.client.predict(text, minConfidence);

    const converted = this.convertToSpanMatches(result.entities, text);
    if (converted.rejected > 0) {
      // 响应不可信：整次预测按失败处理，由调用方的 nerFailure 策略决定降级或阻断
      throw new Error(
        `inference protocol error: ${converted.rejected} entity(ies) failed validation`,
      );
    }
    let spans = converted.spans;

    // Apply policy filtering
    if (policy !== undefined) {
      spans = spans.filter(
        (span) =>
          policy.enabledTypes.has(span.type) &&
          policy.nerEnabledTypes.has(span.type)
      );
    }

    return {
      spans,
      processingTimeMs: result.processingTimeMs,
      modelVersion: this.version,
      // The remote server owns tokenization; windowing/capping does not apply
      // on this path, so coverage is never client-side truncated.
      truncated: false,
      coverageChars: text.length,
    };
  }

  /**
   * 把服务返回的实体转成跨度。
   *
   * 不合规的实体（跨度越界、分数越界、文本与跨度不一致）会被丢弃并计入
   * `rejected`：协议不一致意味着响应不可信，调用方据此按失败处理。
   */
  private convertToSpanMatches(
    entities: ServerEntityMatch[],
    text: string,
  ): { spans: SpanMatch[]; rejected: number } {
    const spans: SpanMatch[] = [];
    let rejected = 0;

    for (const entity of entities) {
      const piiType = SERVER_TYPE_TO_PII_TYPE[entity.type.toUpperCase()];
      // 不支持的类型是协议允许的，不视为协议错误
      if (piiType === undefined) continue;
      // 校验跨度与置信度：协议不一致时宁可丢弃，也不能错位替换
      if (
        typeof entity.confidence !== "number" ||
        entity.confidence < 0 ||
        entity.confidence > 1 ||
        !Number.isInteger(entity.start) ||
        !Number.isInteger(entity.end) ||
        entity.start < 0 ||
        entity.end <= entity.start ||
        entity.end > text.length
      ) {
        rejected++;
        continue;
      }
      if (text.slice(entity.start, entity.end) !== entity.text) {
        rejected++;
        continue;
      }

      spans.push({
        type: piiType,
        start: entity.start,
        end: entity.end,
        confidence: entity.confidence,
        source: DetectionSource.NER,
        text: entity.text,
        recognizer: this.recognizerId,
      });
    }

    return { spans, rejected };
  }

  private getMinConfidence(policy?: AnonymizationPolicy): number {
    if (policy === undefined) return 0.5;

    let minThreshold = 1.0;
    for (const type of policy.nerEnabledTypes) {
      const threshold = policy.confidenceThresholds.get(type) ?? 0.5;
      if (threshold < minThreshold) {
        minThreshold = threshold;
      }
    }

    return minThreshold;
  }

  dispose(): Promise<void> {
    this.isLoaded = false;
    return Promise.resolve();
  }
}

/**
 * Create an Inference Server NER model
 */
export function createInferenceServerNERModel(
  config: InferenceServerNERModelConfig
): InferenceServerNERModel {
  return new InferenceServerNERModel(config);
}
