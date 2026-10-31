// src/validation/evidence-and-date.validator.spec.ts
import {
  verifyAndResolveExtraction,
  matchesTranscriptTurn,
  addBusinessDays,
} from './evidence-and-date.validator';
import {
  RawExtraction,
  TranscriptTurn,
} from '../extraction/schema/extraction.schema';

describe('evidence-and-date.validator', () => {
  const CALL_STARTED_AT = new Date('2026-10-30T14:00:00.000Z'); // Friday, Oct 30, 2026

  const sampleTurns: TranscriptTurn[] = [
    {
      turnId: 0,
      speakerName: 'Alex Rep',
      speakerEmail: 'alex@ourcompany.com',
      isExternal: false,
      timestampMs: 1000,
      text: 'Thanks for joining! I will send over the revised security addendum by next Tuesday.',
    },
    {
      turnId: 1,
      speakerName: 'Sara Buyer',
      speakerEmail: 'sara@acmecorp.io',
      isExternal: true,
      timestampMs: 8500,
      text: "We've got budget sign-off from our VP, so please send the contract over.",
    },
  ];

  const baseRawExtraction: RawExtraction = {
    summary:
      'Sara confirmed VP budget approval and requested the contract. Alex will send the security addendum next Tuesday.',
    key_points: ['VP approved budget', 'Contract requested'],
    stage_proposal: {
      new_stage_id: 'contractsent',
      confidence: 0.91,
      reasoning:
        'Buyer explicitly stated budget is approved and asked for the contract.',
      evidence: [
        {
          turn_id: 1,
          exact_quote:
            'We have got budget sign-off from our VP, so please send the contract over',
        },
      ],
    },
    next_step: {
      action: 'Send revised security addendum',
      owner: 'rep',
      due_date_raw: 'next Tuesday',
      evidence: [
        {
          turn_id: 0,
          exact_quote:
            'I will send over the revised security addendum by next Tuesday',
        },
      ],
    },
    extracted_stage_properties: {},
    risks: [],
    no_update_reason: null,
  };

  it('passes valid quotes (including contraction normalization) and resolves "next Tuesday" against callStartedAt', () => {
    const result = verifyAndResolveExtraction(
      baseRawExtraction,
      sampleTurns,
      CALL_STARTED_AT,
    );

    expect(result.valid).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.resolved?.next_step?.due_date_inferred).toBe(false);
    // Friday Oct 30, 2026 -> next Tuesday is Nov 3, 2026
    expect(
      result.resolved?.next_step?.due_date_iso.startsWith('2026-11-03'),
    ).toBe(true);
  });

  it('rejects hallucinated quotes that do not exist in the referenced turn_id', () => {
    const hallucinated: RawExtraction = {
      ...baseRawExtraction,
      stage_proposal: {
        ...baseRawExtraction.stage_proposal,
        evidence: [
          {
            turn_id: 1,
            exact_quote:
              'We already signed the MSA yesterday and wired the funds',
          },
        ],
      },
    };

    const result = verifyAndResolveExtraction(
      hallucinated,
      sampleTurns,
      CALL_STARTED_AT,
    );

    expect(result.valid).toBe(false);
    expect(result.reasons[0]).toContain('was not found in turn #1');
  });

  it('rejects stage proposals backed only by INTERNAL_REP turns (blocks rep self-talk)', () => {
    const repOnlyStageProposal: RawExtraction = {
      ...baseRawExtraction,
      stage_proposal: {
        ...baseRawExtraction.stage_proposal,
        evidence: [
          {
            turn_id: 0, // Turn 0 is Alex Rep (isExternal: false)
            exact_quote: 'I will send over the revised security addendum',
          },
        ],
      },
    };

    const result = verifyAndResolveExtraction(
      repOnlyStageProposal,
      sampleTurns,
      CALL_STARTED_AT,
    );

    expect(result.valid).toBe(false);
    expect(result.reasons[0]).toContain(
      'require at least one verified quote from an EXTERNAL_PROSPECT',
    );
  });

  it('defaults to +3 business days (skipping weekends) when due_date_raw is null', () => {
    const noDatePhrase: RawExtraction = {
      ...baseRawExtraction,
      next_step: {
        ...baseRawExtraction.next_step!,
        due_date_raw: null,
      },
    };

    const result = verifyAndResolveExtraction(
      noDatePhrase,
      sampleTurns,
      CALL_STARTED_AT,
    );

    expect(result.valid).toBe(true);
    expect(result.resolved?.next_step?.due_date_inferred).toBe(true);
    // Friday Oct 30 + 3 business days (Mon Nov 2, Tue Nov 3, Wed Nov 4) -> 2026-11-04
    expect(
      result.resolved?.next_step?.due_date_iso.startsWith('2026-11-04'),
    ).toBe(true);
  });

  it('supports sliding-window fuzzy match above 0.85 for minor ASR word variance', () => {
    const turn =
      'We are ready to move forward with the annual enterprise pilot next week.';
    const slightlyVariedQuote =
      'ready to move forward with our annual enterprise pilot next week';

    expect(matchesTranscriptTurn(turn, slightlyVariedQuote)).toBe(true);
    expect(
      addBusinessDays(CALL_STARTED_AT, 1)
        .toISOString()
        .startsWith('2026-11-02'),
    ).toBe(true);
  });
});
