interface MessageRateState {
  rateStartedAt: number;
  rateCount: number;
}

interface MessageRateResult {
  allowed: boolean;
  state: MessageRateState;
}

/** 常駐timerを使わず指定時間窓のmessage数を制限する */
export function checkMessageRate(state: MessageRateState, now: number, limit = 60, windowMs = 1000): MessageRateResult {
  const current = now - state.rateStartedAt >= windowMs
    ? { rateStartedAt: now, rateCount: 0 }
    : state;
  const next = { rateStartedAt: current.rateStartedAt, rateCount: current.rateCount + 1 };
  return { allowed: next.rateCount <= limit, state: next };
}
