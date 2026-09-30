import { Injectable } from '@nestjs/common';
import { ParamsErrorException } from '@nest-cloud/common';
import { calculateJaccard } from './jaccard';
import {
  alignMatchToCompleteUnits,
  countNormalizedUnits,
  countUnitsInRange,
  resolveCountingMode,
} from './plagiarism-counting';
import { PLAGIARISM_CONFIG } from './plagiarism.constants';
import { mergeMatches } from './interval';
import {
  expandMatch,
  findCommonSubstrings,
  mergeAdjacentMatches,
  mergeApproximateMatches,
  selectNonOverlappingMatches,
} from './lcs';
import { createNGrams, summarizeNGrams } from './ngram';
import { segmentText } from './text-segmenter';
import { expandContext, validateMatch } from './plagiarism-scoring';
import {
  calculateHammingDistance,
  calculateSimHash,
  calculateSimHashSimilarity,
  formatSimHash,
} from './simhash';
import { mapNormalizedRange, normalizeText } from './text-normalizer';
import type {
  BlockComparison,
  NormalizedText,
  PlagiarismCompareInput,
  PlagiarismDirectionResult,
  PlagiarismMatch,
  PlagiarismResult,
  PlagiarismStep,
  RawPlagiarismMatch,
  TextBlock,
} from './plagiarism.types';

/** 在单次请求内按分句/分块完成可解释查重，不保存原文或结果。 */
@Injectable()
export class PlagiarismService {
  compare(input: PlagiarismCompareInput): PlagiarismResult {
    const source = input.source;
    const target = input.target;
    this.validateInput(source, target);
    const threshold = this.resolveThreshold(input.threshold);
    const editDistance = this.resolveEditDistance(input.editDistance);
    const normalizedSource = normalizeText(source);
    const normalizedTarget = normalizeText(target);
    if (!normalizedSource.value || !normalizedTarget.value) {
      throw new ParamsErrorException('文本清洗后没有可用于查重的中文、英文或数字内容。');
    }

    const sourceToTarget = this.compareDirection({
      sourceText: source,
      targetText: target,
      source: normalizedSource,
      target: normalizedTarget,
      threshold,
      editDistance,
    });
    const targetToSource = this.compareDirection({
      sourceText: target,
      targetText: source,
      source: normalizedTarget,
      target: normalizedSource,
      threshold,
      editDistance,
    });
    const overallSimilarity = this.round(
      (sourceToTarget.similarity + targetToSource.similarity) / 2,
    );
    return {
      ...sourceToTarget,
      similarity: overallSimilarity,
      overallSimilarity,
      sourceToTarget,
      targetToSource,
    };
  }

  private compareDirection(options: {
    sourceText: string;
    targetText: string;
    source: NormalizedText;
    target: NormalizedText;
    threshold: number;
    editDistance: number;
  }): PlagiarismDirectionResult {
    const {
      sourceText,
      targetText,
      source: normalizedSource,
      target: normalizedTarget,
      threshold,
      editDistance,
    } = options;
    const sourceBlocks = segmentText(
      sourceText,
      normalizedSource,
      PLAGIARISM_CONFIG.minBlockLength,
    );
    const targetBlocks = segmentText(
      targetText,
      normalizedTarget,
      PLAGIARISM_CONFIG.minBlockLength,
    );
    const sourceGrams = createNGrams(normalizedSource.value, PLAGIARISM_CONFIG.ngramSize);
    const targetGrams = createNGrams(normalizedTarget.value, PLAGIARISM_CONFIG.ngramSize);
    const ngramSummary = summarizeNGrams(sourceGrams, targetGrams);
    const featureless = sourceGrams.size === 0 && targetGrams.size === 0;
    const comparableFeatures = sourceGrams.size > 0 && targetGrams.size > 0;
    const shortTextSimilarity = normalizedSource.value === normalizedTarget.value ? 1 : 0;
    const jaccard = featureless ? shortTextSimilarity : calculateJaccard(sourceGrams, targetGrams);
    const sourceHash = calculateSimHash(sourceGrams, PLAGIARISM_CONFIG.simHashBits);
    const targetHash = calculateSimHash(targetGrams, PLAGIARISM_CONFIG.simHashBits);
    const simHashDistance = calculateHammingDistance(
      sourceHash,
      targetHash,
      PLAGIARISM_CONFIG.simHashBits,
    );
    const simHashSimilarity = featureless
      ? shortTextSimilarity
      : comparableFeatures
        ? calculateSimHashSimilarity(sourceHash, targetHash, PLAGIARISM_CONFIG.simHashBits)
        : 0;

    const blockResult = this.findBlockMatches(sourceBlocks, targetBlocks, editDistance);
    const candidates = mergeMatches(
      mergeAdjacentMatches(
        selectNonOverlappingMatches(blockResult.candidates),
        PLAGIARISM_CONFIG.maxSourceGap,
        PLAGIARISM_CONFIG.maxTargetGap,
        PLAGIARISM_CONFIG.minMergePartLength,
      ),
    )
      .map((candidate) => alignMatchToCompleteUnits(candidate, normalizedSource, normalizedTarget))
      .filter(
        (candidate): candidate is RawPlagiarismMatch =>
          candidate !== null && candidate.length >= PLAGIARISM_CONFIG.minMatchLength,
      );
    const scoredCandidates = candidates.map((candidate) =>
      this.toPublicMatch(candidate, normalizedSource, normalizedTarget, sourceText, targetText),
    );
    const countedCandidates = scoredCandidates.filter((match) => match.counted);
    const countedCandidateRanges = candidates.filter((_, index) => scoredCandidates[index].counted);
    const matches = countedCandidates.filter((match) => match.similarity >= threshold);
    const duplicateLength = calculateCoveredSourceLength(countedCandidateRanges);
    const duplicateUnitCount = countCoveredSourceUnits(normalizedSource, countedCandidateRanges);
    const sourceUnitCount = countNormalizedUnits(normalizedSource);
    const targetUnitCount = countNormalizedUnits(normalizedTarget);
    const countingMode = resolveCountingMode(normalizedSource);
    const duplicateRate = sourceUnitCount === 0 ? 0 : duplicateUnitCount / sourceUnitCount;
    const similarity = this.round(
      jaccard * PLAGIARISM_CONFIG.jaccardWeight +
        simHashSimilarity * PLAGIARISM_CONFIG.simHashWeight +
        duplicateRate * PLAGIARISM_CONFIG.duplicateRateWeight,
    );
    const sourceLength = [...normalizedSource.value].length;
    const targetLength = [...normalizedTarget.value].length;

    const steps: PlagiarismStep[] = [
      {
        key: 'normalize',
        label: '文本标准化',
        data: {
          sourceLength,
          targetLength,
          sourceUnitCount,
          targetUnitCount,
          countingMode,
          sourceRemovedCharacters: Math.max(0, [...sourceText].length - sourceLength),
          targetRemovedCharacters: Math.max(0, [...targetText].length - targetLength),
          rule: 'Unicode NFKC、大小写归一化、去除空白/标点/合法 HTML 标签；中文按字、英文按完整单词统计，保留原文位置映射',
        },
      },
      {
        key: 'segment',
        label: '分句 / 分块',
        data: {
          sourceBlockCount: sourceBlocks.length,
          targetBlockCount: targetBlocks.length,
          minBlockLength: PLAGIARISM_CONFIG.minBlockLength,
          sourceBlocks: this.serializeBlocks(sourceBlocks),
          targetBlocks: this.serializeBlocks(targetBlocks),
        },
      },
      {
        key: 'ngram',
        label: '3-gram 特征',
        data: ngramSummary,
      },
      {
        key: 'block-match',
        label: '相同 / 近似片段候选',
        data: {
          pairCount: blockResult.comparisons.length,
          comparisons: blockResult.comparisons,
        },
      },
      {
        key: 'jaccard',
        label: 'Jaccard 相似度',
        similarity: this.round(jaccard),
        data: {
          value: this.round(jaccard),
          commonCount: ngramSummary.commonCount,
          unionCount: sourceGrams.size + targetGrams.size - ngramSummary.commonCount,
          formula: '交集 N-gram 数 / 并集 N-gram 数',
        },
      },
      {
        key: 'simhash',
        label: 'SimHash 相似度',
        similarity: this.round(simHashSimilarity),
        data: {
          value: this.round(simHashSimilarity),
          hammingDistance: simHashDistance,
          bits: PLAGIARISM_CONFIG.simHashBits,
          sourceHash: formatSimHash(sourceHash),
          targetHash: formatSimHash(targetHash),
        },
      },
      {
        key: 'lcs',
        label: '连续匹配扩展',
        data: {
          minMatchLength: PLAGIARISM_CONFIG.minMatchLength,
          candidateCount: scoredCandidates.length,
          matches: scoredCandidates,
        },
      },
      {
        key: 'threshold',
        label: '最小长度 / 阈值筛选',
        similarity: threshold,
        data: {
          threshold,
          editDistance,
          minDuplicateUnitCount: PLAGIARISM_CONFIG.minDuplicateUnitCount,
          candidateCount: scoredCandidates.length,
          countedCount: countedCandidates.length,
          highlightedCount: matches.length,
          highlightedLength: matches.reduce((total, match) => total + match.length, 0),
          filteredCount: scoredCandidates.length - matches.length,
          matches,
        },
      },
      {
        key: 'final',
        label: '重复区间与最终结果',
        similarity,
        data: {
          similarity,
          duplicateRate: this.round(duplicateRate),
          duplicateLength,
          sourceLength,
          targetLength,
          duplicateUnitCount,
          sourceUnitCount,
          targetUnitCount,
          countingMode,
          matches,
        },
      },
    ];

    return {
      similarity,
      duplicateRate: this.round(duplicateRate),
      duplicateLength,
      sourceLength,
      targetLength,
      duplicateUnitCount,
      sourceUnitCount,
      targetUnitCount,
      countingMode,
      threshold,
      editDistance,
      matches,
      steps,
    };
  }

  private validateInput(source: string, target: string): void {
    if (
      source.length > PLAGIARISM_CONFIG.maxTextLength ||
      target.length > PLAGIARISM_CONFIG.maxTextLength
    ) {
      throw new ParamsErrorException(`每份答案最多 ${PLAGIARISM_CONFIG.maxTextLength} 个字符。`);
    }
    if (!source.trim() || !target.trim()) {
      throw new ParamsErrorException('答案 A 和答案 B 不能为空。');
    }
  }

  private findBlockMatches(
    sourceBlocks: TextBlock[],
    targetBlocks: TextBlock[],
    editDistance: number,
  ): { candidates: RawPlagiarismMatch[]; comparisons: BlockComparison[] } {
    const candidates: RawPlagiarismMatch[] = [];
    const comparisons: BlockComparison[] = [];
    for (const sourceBlock of sourceBlocks) {
      const sourceGrams = createNGrams(sourceBlock.text, PLAGIARISM_CONFIG.ngramSize);
      for (const targetBlock of targetBlocks) {
        const targetGrams = createNGrams(targetBlock.text, PLAGIARISM_CONFIG.ngramSize);
        const summary = summarizeNGrams(sourceGrams, targetGrams);
        if (summary.commonCount === 0) continue;
        const blockSimilarity = this.calculateFeatureSimilarity(
          sourceBlock.text,
          targetBlock.text,
          sourceGrams,
          targetGrams,
        );
        comparisons.push({
          sourceBlock: sourceBlock.index,
          targetBlock: targetBlock.index,
          sourceLength: [...sourceBlock.text].length,
          targetLength: [...targetBlock.text].length,
          sourceText: sourceBlock.text,
          targetText: targetBlock.text,
          commonNGramCount: summary.commonCount,
          similarity: this.round(blockSimilarity),
        });
        const localMatches = mergeApproximateMatches(
          selectNonOverlappingMatches(
            findCommonSubstrings(
              sourceBlock.text,
              targetBlock.text,
              PLAGIARISM_CONFIG.minMatchLength,
            ),
          ),
          sourceBlock.text,
          targetBlock.text,
          editDistance,
          editDistance,
        );
        for (const localMatch of localMatches) {
          const expanded = expandMatch(sourceBlock.text, targetBlock.text, localMatch);
          if (expanded.length < PLAGIARISM_CONFIG.minMatchLength) continue;
          candidates.push({
            ...expanded,
            sourceStart: expanded.sourceStart + sourceBlock.normalizedStart,
            sourceEnd: expanded.sourceEnd + sourceBlock.normalizedStart,
            targetStart: expanded.targetStart + targetBlock.normalizedStart,
            targetEnd: expanded.targetEnd + targetBlock.normalizedStart,
            sourceBlock: sourceBlock.index,
            targetBlock: targetBlock.index,
            blockSimilarity,
            sourceBlockLength: [...sourceBlock.text].length,
            targetBlockLength: [...targetBlock.text].length,
          });
        }
      }
    }
    return { candidates, comparisons };
  }

  private serializeBlocks(blocks: TextBlock[]): Array<Record<string, unknown>> {
    return blocks.map((block) => ({
      index: block.index,
      normalizedStart: block.normalizedStart,
      normalizedEnd: block.normalizedEnd,
      originalStart: block.originalStart,
      originalEnd: block.originalEnd,
      length: block.normalizedEnd - block.normalizedStart,
      text: block.text,
    }));
  }

  private calculateFeatureSimilarity(
    sourceText: string,
    targetText: string,
    sourceGrams: Set<string>,
    targetGrams: Set<string>,
  ): number {
    if (sourceGrams.size === 0 && targetGrams.size === 0) {
      return sourceText === targetText ? 1 : 0;
    }
    return calculateJaccard(sourceGrams, targetGrams);
  }

  private toPublicMatch(
    candidate: RawPlagiarismMatch,
    source: NormalizedText,
    target: NormalizedText,
    sourceText: string,
    targetText: string,
  ): PlagiarismMatch {
    const sourcePosition = mapNormalizedRange(source, candidate.sourceStart, candidate.sourceEnd);
    const targetPosition = mapNormalizedRange(target, candidate.targetStart, candidate.targetEnd);
    const context = expandContext(
      source.value,
      target.value,
      candidate,
      PLAGIARISM_CONFIG.contextBefore,
      PLAGIARISM_CONFIG.contextAfter,
    );
    const validation = validateMatch(
      candidate,
      context,
      PLAGIARISM_CONFIG.minScore,
      PLAGIARISM_CONFIG.lengthScoreWeight,
      PLAGIARISM_CONFIG.densityScoreWeight,
    );
    const sourceContextPosition = mapNormalizedRange(
      source,
      context.sourceContextStart,
      context.sourceContextEnd,
    );
    const targetContextPosition = mapNormalizedRange(
      target,
      context.targetContextStart,
      context.targetContextEnd,
    );
    const sourceUnitCount = countUnitsInRange(source, candidate.sourceStart, candidate.sourceEnd);
    const targetUnitCount = countUnitsInRange(target, candidate.targetStart, candidate.targetEnd);
    const counted =
      validation.counted &&
      sourceUnitCount >= PLAGIARISM_CONFIG.minDuplicateUnitCount &&
      targetUnitCount >= PLAGIARISM_CONFIG.minDuplicateUnitCount;
    return {
      sourceStart: sourcePosition.start,
      sourceEnd: sourcePosition.end,
      targetStart: targetPosition.start,
      targetEnd: targetPosition.end,
      text: sourceText.slice(sourcePosition.start, sourcePosition.end),
      length: candidate.length,
      sourceContext: sourceText.slice(sourceContextPosition.start, sourceContextPosition.end),
      targetContext: targetText.slice(targetContextPosition.start, targetContextPosition.end),
      ...validation,
      counted,
      similarity: this.round(validation.score),
      sourceUnitCount,
      targetUnitCount,
    };
  }

  private resolveEditDistance(value: number | undefined): number {
    const editDistance = value ?? PLAGIARISM_CONFIG.defaultEditDistance;
    if (!Number.isInteger(editDistance) || editDistance < PLAGIARISM_CONFIG.minEditDistance) {
      throw new ParamsErrorException('编辑距离必须是非负整数。');
    }
    return editDistance;
  }

  private resolveThreshold(value: number | undefined): number {
    const threshold = value ?? PLAGIARISM_CONFIG.defaultThreshold;
    if (
      !Number.isFinite(threshold) ||
      threshold < PLAGIARISM_CONFIG.minThreshold ||
      threshold > PLAGIARISM_CONFIG.maxThreshold
    ) {
      throw new ParamsErrorException('相似阈值必须是 0 到 1 之间的数字。');
    }
    return this.round(threshold);
  }

  private round(value: number): number {
    return Number(value.toFixed(6));
  }
}

function calculateCoveredSourceLength(matches: RawPlagiarismMatch[]): number {
  return mergeSourceRanges(matches).reduce((total, range) => total + range.end - range.start, 0);
}

function countCoveredSourceUnits(
  normalized: NormalizedText,
  matches: RawPlagiarismMatch[],
): number {
  const ranges = mergeSourceRanges(matches);
  return normalized.units.filter((unit) =>
    ranges.some((range) => unit.start >= range.start && unit.end <= range.end),
  ).length;
}

function mergeSourceRanges(matches: RawPlagiarismMatch[]): Array<{ start: number; end: number }> {
  const ordered = [...matches]
    .filter((match) => match.sourceEnd > match.sourceStart)
    .sort(
      (left, right) => left.sourceStart - right.sourceStart || left.sourceEnd - right.sourceEnd,
    );
  const ranges: Array<{ start: number; end: number }> = [];
  for (const match of ordered) {
    const previous = ranges.at(-1);
    if (previous && match.sourceStart <= previous.end) {
      previous.end = Math.max(previous.end, match.sourceEnd);
      continue;
    }
    ranges.push({ start: match.sourceStart, end: match.sourceEnd });
  }
  return ranges;
}
