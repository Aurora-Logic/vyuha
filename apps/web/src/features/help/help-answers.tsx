import { CompassIcon, PaperPlaneTiltIcon, QuestionIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/api/client';

import { rankHelpCards } from './rank';
import { useHelpCards } from './use-help-cards';

/**
 * REQ-AJ-01 (proposed): the answer half of Ctrl+F1.
 *
 * PRD §6.4 calls that key "contextual help / shortcut sheet" and until now it
 * only did the second half — the same observation that put "Walk me through
 * this screen" here. A shortcut list answers "what can I press"; this answers
 * "why will it not let me", which is the question people actually stop and
 * ask.
 *
 * **Not a chat.** One question in, one answer out, no transcript to scroll
 * and no follow-up to compose. The cards are written as finished answers of
 * one to three sentences, so there is nothing to summarise at read time and
 * nothing here has to reach a model. What it gives up is tolerance of
 * phrasing nobody wrote an alias for; what it gets is an answer that appears
 * as you type, never leaves the browser, and can be tested.
 *
 * **A miss says so.** Below the confidence floor the panel does not print its
 * best guess under a heading that claims it is the answer — it says nothing
 * matched and offers the closest questions as questions. The product's own
 * constitution says to stop rather than guess on punch rules, leave accrual
 * and anything involving money; a help panel is the easiest place to break
 * that by accident.
 *
 * No card inside a card (CLAUDE.md §3.3): answers are divider-separated rows
 * on the dialog's own surface, the same shape the Updates screen uses.
 */

interface HelpAnswersProps {
  /** What was typed. Already trimmed by the caller. */
  readonly query: string;
  /** The route being looked at, so a card about this screen breaks ties. */
  readonly route: string;
  /** Fill the search box with a near miss the reader picked. */
  readonly onAskInstead: (question: string) => void;
  /** Close the dialog and walk the reader through a step on the real screen. */
  readonly onShowMe: (tourStep: string) => void;
}

export function HelpAnswers({ query, route, onAskInstead, onShowMe }: HelpAnswersProps) {
  const { data: cards, isPending, isError, error, refetch } = useHelpCards(true);
  // REQ-AJ-05: sending is an explicit act and the confirmation must survive
  // re-ranking, so the sent question is remembered rather than a boolean.
  const [sentQuestion, setSentQuestion] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function sendToAdmin() {
    setSending(true);
    try {
      await apiRequest('/help/questions', { method: 'POST', body: { question: query } });
      setSentQuestion(query);
    } catch (sendError) {
      toast.add({ type: 'error', title: 'Could not send the question', description: sendError instanceof Error ? sendError.message : 'Try again.' });
    } finally {
      setSending(false);
    }
  }

  if (isPending) {
    return (
      <div className="text-muted-foreground flex min-h-24 items-center justify-center gap-2 text-sm">
        <Spinner />
        Looking
      </div>
    );
  }

  if (isError) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <QuestionIcon />
          </EmptyMedia>
          <EmptyTitle>Could not load the answers</EmptyTitle>
          <EmptyDescription>{error.message}</EmptyDescription>
        </EmptyHeader>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void refetch();
          }}
        >
          Try again
        </Button>
      </Empty>
    );
  }

  const { answers, nearMisses } = rankHelpCards(query, cards, route);

  if (answers.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <QuestionIcon />
          </EmptyMedia>
          <EmptyTitle>No answer for that yet</EmptyTitle>
          <EmptyDescription>
            {nearMisses.length > 0
              ? 'The closest things written down are below. If none of them is your question, your administrator can add it.'
              : 'Nothing here covers it. Your administrator can add an answer for it.'}
          </EmptyDescription>
        </EmptyHeader>
        {/* Sending is deliberate, never silent: the question is employee free
            text and leaves the panel only on this click (REQ-AJ-05). */}
        {query.trim().length >= 3 ? (
          sentQuestion === query ? (
            <p className="text-muted-foreground text-sm">Sent. Your administrator sees it in their notifications.</p>
          ) : (
            <Button size="sm" variant="outline" disabled={sending} onClick={() => void sendToAdmin()}>
              <PaperPlaneTiltIcon data-icon="inline-start" />
              Send this question to your administrator
            </Button>
          )
        ) : null}
        {nearMisses.length > 0 ? (
          <div className="flex w-full flex-col">
            {nearMisses.map(({ card }) => (
              <Button
                key={card.id}
                variant="ghost"
                className="h-auto justify-start py-2 text-left text-sm whitespace-normal"
                onClick={() => {
                  onAskInstead(card.question);
                }}
              >
                {card.question}
              </Button>
            ))}
          </div>
        ) : null}
      </Empty>
    );
  }

  return (
    <div className="flex flex-col">
      {answers.map(({ card }) => (
        <article key={card.id} className="flex flex-col gap-1.5 border-b py-3 last:border-b-0">
          <h3 className="text-sm font-medium">{card.question}</h3>
          <p className="text-muted-foreground text-sm leading-relaxed">{card.answer}</p>
          {card.tourStep !== null ? (
            <Button
              variant="outline"
              size="sm"
              className="mt-1 self-start"
              onClick={() => {
                onShowMe(card.tourStep ?? '');
              }}
            >
              <CompassIcon data-icon="inline-start" />
              Show me
            </Button>
          ) : null}
        </article>
      ))}
    </div>
  );
}
