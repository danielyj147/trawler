/**
 * Information Retrieval metrics for evaluating retrieval + ranking quality.
 *
 * Uses LLM qualifier scores as graded relevance judgments:
 *   3 = push (score >= 65)
 *   2 = digest (score 40-64)
 *   1 = marginal (score 20-39)
 *   0 = irrelevant (score < 20 or hard-rejected)
 */

export interface IRMetrics {
  ndcg_at_5: number;
  ndcg_at_10: number;
  ndcg_at_30: number;
  mrr: number;
  precision_at_5: number;
  precision_at_10: number;
  precision_at_30: number;
  recall_at_30: number;
  map: number;
  total_relevant: number;
  total_evaluated: number;
}

function relevanceGrade(score: number, hardRejected: boolean): number {
  if (hardRejected) return 0;
  if (score >= 65) return 3;
  if (score >= 40) return 2;
  if (score >= 20) return 1;
  return 0;
}

function dcg(grades: number[], k: number): number {
  let sum = 0;
  for (let i = 0; i < Math.min(grades.length, k); i++) {
    sum += (Math.pow(2, grades[i]) - 1) / Math.log2(i + 2);
  }
  return sum;
}

function ndcg(grades: number[], k: number): number {
  const actual = dcg(grades, k);
  const ideal = dcg([...grades].sort((a, b) => b - a), k);
  return ideal > 0 ? actual / ideal : 1.0;
}

/**
 * Compute IR metrics from ranked results.
 *
 * @param results - ranked list of { score, hard_rejected } in retrieval order
 * @param relevantThreshold - minimum grade to count as "relevant" for precision/recall/MAP
 */
export function computeIRMetrics(
  results: { score: number; hardRejected: boolean }[],
  relevantThreshold: number = 2, // digest+ counts as relevant
): IRMetrics {
  const grades = results.map(r => relevanceGrade(r.score, r.hardRejected));
  const relevant = grades.filter(g => g >= relevantThreshold);
  const totalRelevant = relevant.length;

  // NDCG@K
  const ndcg5 = ndcg(grades, 5);
  const ndcg10 = ndcg(grades, 10);
  const ndcg30 = ndcg(grades, 30);

  // MRR — position of first relevant result
  let mrr = 0;
  for (let i = 0; i < grades.length; i++) {
    if (grades[i] >= relevantThreshold) {
      mrr = 1 / (i + 1);
      break;
    }
  }

  // Precision@K
  const precAt = (k: number) => {
    const slice = grades.slice(0, k);
    return slice.length > 0 ? slice.filter(g => g >= relevantThreshold).length / slice.length : 0;
  };

  // Recall@K
  const recallAt = (k: number) => {
    if (totalRelevant === 0) return 1.0;
    const found = grades.slice(0, k).filter(g => g >= relevantThreshold).length;
    return found / totalRelevant;
  };

  // MAP — mean of precision at each relevant position
  let mapSum = 0;
  let relevantSoFar = 0;
  for (let i = 0; i < grades.length; i++) {
    if (grades[i] >= relevantThreshold) {
      relevantSoFar++;
      mapSum += relevantSoFar / (i + 1);
    }
  }
  const mapScore = totalRelevant > 0 ? mapSum / totalRelevant : 0;

  return {
    ndcg_at_5: ndcg5,
    ndcg_at_10: ndcg10,
    ndcg_at_30: ndcg30,
    mrr,
    precision_at_5: precAt(5),
    precision_at_10: precAt(10),
    precision_at_30: precAt(30),
    recall_at_30: recallAt(30),
    map: mapScore,
    total_relevant: totalRelevant,
    total_evaluated: results.length,
  };
}

export function formatIRMetrics(m: IRMetrics): string {
  const L: string[] = [];
  L.push('  IR METRICS');
  L.push('  ' + '-'.repeat(40));
  L.push(`  NDCG@5                    ${m.ndcg_at_5.toFixed(3)}`);
  L.push(`  NDCG@10                   ${m.ndcg_at_10.toFixed(3)}`);
  L.push(`  NDCG@30                   ${m.ndcg_at_30.toFixed(3)}`);
  L.push(`  MRR                       ${m.mrr.toFixed(3)}`);
  L.push(`  Precision@5               ${m.precision_at_5.toFixed(3)}`);
  L.push(`  Precision@10              ${m.precision_at_10.toFixed(3)}`);
  L.push(`  Precision@30              ${m.precision_at_30.toFixed(3)}`);
  L.push(`  Recall@30                 ${m.recall_at_30.toFixed(3)}`);
  L.push(`  MAP                       ${m.map.toFixed(3)}`);
  L.push(`  Relevant (digest+)        ${m.total_relevant} / ${m.total_evaluated}`);
  return L.join('\n');
}
