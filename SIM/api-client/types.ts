// СГЕНЕРИРОВАНО. Не редактировать руками: npm run api-client
// Источник: api/openapi.json, а он — из фактических ответов сервера.
/** Схема `SessionResponse` из openapi.json. */
export type SessionResponse = {
  readonly apiVersion: string;
  readonly id: string;
  readonly seed: number;
  readonly level: string;
  readonly overlay: string;
  readonly horizonShifts: number;
  readonly currentShift: number;
  readonly decisions: readonly {
    readonly type: string;
    readonly batchId: string;
    readonly rank: number;
    readonly appliedAt: number;
  }[];
  readonly createdAt: string;
  readonly replayable: boolean;
  readonly summary: {
    readonly layer: string;
    readonly shift: number;
    readonly metrics: {
      readonly portfolio: {
        readonly id: string;
        readonly value: {
          readonly openCount: number;
          readonly remainderNormHours: number;
          readonly ordersWithoutNorm: number;
        };
        readonly coverage: number;
        readonly reads: readonly string[];
      };
      readonly overload: {
        readonly id: string;
        readonly value: {
          readonly areas: readonly {
            readonly areaId: string;
            readonly areaName: string;
            readonly load: number;
            readonly overloaded: boolean;
            readonly queueUnit: string;
            readonly queueAmount: number;
            readonly problem: string;
          }[];
          readonly overloadedCount: number;
          readonly queueByUnit: readonly {
            readonly unit: string;
            readonly amount: number;
          }[];
        };
        readonly coverage: number;
        readonly reads: readonly string[];
      };
      readonly acceptedShift: {
        readonly id: string;
        readonly value: {
          readonly normHours: number;
          readonly masterCloses: number;
          readonly workerCloses: number;
          readonly duplicateFacts: number;
        };
        readonly coverage: number;
        readonly reads: readonly string[];
      };
      readonly scheduleRisk: {
        readonly id: string;
        readonly value: {
          readonly overdue: number;
          readonly onTime: number;
          readonly unevaluated: number;
        };
        readonly coverage: number;
        readonly reads: readonly string[];
      };
    };
    readonly reliability: readonly {
      readonly id: string;
      readonly coverage: number;
    }[];
    readonly areas: readonly {
      readonly areaId: string;
      readonly areaName: string;
      readonly capacity: {
        readonly kind: string;
        readonly amount: number;
      };
      readonly plan: {
        readonly kind: string;
        readonly amount: number;
      };
      readonly queue: {
        readonly kind: string;
        readonly amount: number;
      };
    }[];
  };
  readonly decisionJournal: readonly {
    readonly at: number;
    readonly action: string;
    readonly basisMetric: string;
    readonly basisValue: string;
    readonly coverage: number;
    readonly consequence: string;
  }[];
};

/** Схема `AdvanceResponse` из openapi.json. */
export type AdvanceResponse = {
  readonly apiVersion: string;
  readonly currentShift: number;
  readonly summary: {
    readonly layer: string;
    readonly shift: number;
    readonly metrics: {
      readonly portfolio: {
        readonly id: string;
        readonly value: {
          readonly openCount: number;
          readonly remainderNormHours: number;
          readonly ordersWithoutNorm: number;
        };
        readonly coverage: number;
        readonly reads: readonly string[];
      };
      readonly overload: {
        readonly id: string;
        readonly value: {
          readonly areas: readonly {
            readonly areaId: string;
            readonly areaName: string;
            readonly load: number;
            readonly overloaded: boolean;
            readonly queueUnit: string;
            readonly queueAmount: number;
            readonly problem: string;
          }[];
          readonly overloadedCount: number;
          readonly queueByUnit: readonly {
            readonly unit: string;
            readonly amount: number;
          }[];
        };
        readonly coverage: number;
        readonly reads: readonly string[];
      };
      readonly acceptedShift: {
        readonly id: string;
        readonly value: {
          readonly normHours: number;
          readonly masterCloses: number;
          readonly workerCloses: number;
          readonly duplicateFacts: number;
        };
        readonly coverage: number;
        readonly reads: readonly string[];
      };
      readonly scheduleRisk: {
        readonly id: string;
        readonly value: {
          readonly overdue: number;
          readonly onTime: number;
          readonly unevaluated: number;
        };
        readonly coverage: number;
        readonly reads: readonly string[];
      };
    };
    readonly reliability: readonly {
      readonly id: string;
      readonly coverage: number;
    }[];
    readonly areas: readonly {
      readonly areaId: string;
      readonly areaName: string;
      readonly capacity: {
        readonly kind: string;
        readonly amount: number;
      };
      readonly plan: {
        readonly kind: string;
        readonly amount: number;
      };
      readonly queue: {
        readonly kind: string;
        readonly amount: number;
      };
    }[];
  };
  readonly events: readonly {
    readonly at: number;
    readonly type: string;
    readonly payload: {
      readonly shift: number;
      readonly summary?: {
        readonly layer: string;
        readonly shift: number;
        readonly metrics: {
          readonly portfolio: {
            readonly id: string;
            readonly value: {
              readonly openCount: number;
              readonly remainderNormHours: number;
              readonly ordersWithoutNorm: number;
            };
            readonly coverage: number;
            readonly reads: readonly string[];
          };
          readonly overload: {
            readonly id: string;
            readonly value: {
              readonly areas: readonly {
                readonly areaId: string;
                readonly areaName: string;
                readonly load: number;
                readonly overloaded: boolean;
                readonly queueUnit: string;
                readonly queueAmount: number;
                readonly problem: string;
              }[];
              readonly overloadedCount: number;
              readonly queueByUnit: readonly {
                readonly unit: string;
                readonly amount: number;
              }[];
            };
            readonly coverage: number;
            readonly reads: readonly string[];
          };
          readonly acceptedShift: {
            readonly id: string;
            readonly value: {
              readonly normHours: number;
              readonly masterCloses: number;
              readonly workerCloses: number;
              readonly duplicateFacts: number;
            };
            readonly coverage: number;
            readonly reads: readonly string[];
          };
          readonly scheduleRisk: {
            readonly id: string;
            readonly value: {
              readonly overdue: number;
              readonly onTime: number;
              readonly unevaluated: number;
            };
            readonly coverage: number;
            readonly reads: readonly string[];
          };
        };
        readonly reliability: readonly {
          readonly id: string;
          readonly coverage: number;
        }[];
        readonly areas: readonly {
          readonly areaId: string;
          readonly areaName: string;
          readonly capacity: {
            readonly kind: string;
            readonly amount: number;
          };
          readonly plan: {
            readonly kind: string;
            readonly amount: number;
          };
          readonly queue: {
            readonly kind: string;
            readonly amount: number;
          };
        }[];
      };
    };
    readonly seq: number;
  }[];
};

/** Схема `ShopResponse` из openapi.json. */
export type ShopResponse = {
  readonly apiVersion: string;
  readonly layer: string;
  readonly reality: {
    readonly now: number;
    readonly areas: readonly {
      readonly id: string;
      readonly name: string;
      readonly role: {
        readonly role: string;
        readonly resourceKind?: string;
        readonly schedule?: string;
      };
      readonly evidence: string;
      readonly evidenceNote: string;
    }[];
    readonly resources: readonly {
      readonly id: string;
      readonly areaId: string;
      readonly kind: string;
      readonly chargePieces: number | null;
    }[];
    readonly batches: readonly {
      readonly id: string;
      readonly partId: string;
      readonly qty: number;
      readonly parentId: null;
      readonly tearOff: null;
      readonly countsApart: boolean;
      readonly materialReady: boolean;
      readonly designDocReady: boolean;
      readonly operationIds: readonly string[];
    }[];
    readonly operations: readonly {
      readonly id: string;
      readonly batchId: string;
      readonly areaId: string;
      readonly sequence: number;
      readonly status: string;
      readonly missing: readonly string[];
      readonly planned: number;
      readonly done: number;
      readonly scrap: number;
      readonly effort: {
        readonly kind: string;
        readonly amount: number;
      } | null;
      readonly resourceId: string | null;
    }[];
    readonly downtimes: readonly unknown[];
  };
  readonly shift: number;
};

/** Схема `RolesResponse` из openapi.json. */
export type RolesResponse = {
  readonly apiVersion: string;
  readonly layer: string;
  readonly shift: number;
  readonly records: readonly {
    readonly role: string;
    readonly kind: string;
    readonly ref: string;
    readonly at: number | null;
    readonly status?: string;
    readonly contractDue?: number;
    readonly orderId?: string;
    readonly operationId: string | null;
    readonly norm?: {
      readonly kind: string;
      readonly amount: number;
    };
    readonly trueTime?: number;
    readonly versionId?: string;
    readonly calculatedDue?: number;
    readonly technology: null;
    readonly production: null;
    readonly control: null;
    readonly done?: number;
    readonly scrap?: number;
    readonly areaName?: string;
    readonly capacity?: {
      readonly kind: string;
      readonly amount: number;
    };
    readonly plan?: {
      readonly kind: string;
      readonly amount: number;
    };
    readonly queue?: {
      readonly kind: string;
      readonly amount: number;
    };
  }[];
};

/** Схема `DecisionResponse` из openapi.json. */
export type DecisionResponse = {
  readonly apiVersion: string;
  readonly decision: {
    readonly type: string;
    readonly batchId: string;
    readonly rank: number;
    readonly appliedAt: number;
  };
  readonly journal: {
    readonly at: number;
    readonly action: string;
    readonly basisMetric: string;
    readonly basisValue: string;
    readonly coverage: number;
    readonly consequence: string;
  };
  readonly event: {
    readonly at: number;
    readonly type: string;
    readonly payload: {
      readonly type: string;
      readonly batchId: string;
      readonly rank: number;
      readonly appliedAt: number;
    };
    readonly seq: number;
  };
};

/** Схема `ErrorResponse` из openapi.json. */
export type ErrorResponse = {
  readonly apiVersion: string;
  readonly error: string;
};

/** Схема `UnknownVersionResponse` из openapi.json. */
export type UnknownVersionResponse = {
  readonly apiVersion: string;
  readonly error: string;
  readonly supported: readonly string[];
};

/** Схема `EventTypes` из openapi.json. */
export type EventTypes = "shift-started" | "shift-completed" | "metrics-updated" | "decision-applied" | "session-finished";
