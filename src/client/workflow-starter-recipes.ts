import type { WorkflowStep } from '../server/linkedin/workflows.js';

/**
 * More Dripify-parity starter sequences, for the actual Managed Campaign
 * workflow editor rather than the older export-only sequence library.
 *
 * Each recipe is an editable, saved definition, never a send command. The
 * browser worker still enforces exact review, recipient and workspace
 * policy, connection state, mail compliance and per-seat capacity.
 */
export interface WorkflowStarterRecipe {
  key: string;
  label: string;
  blurb: string;
  build: (mint: () => string) => WorkflowStep[];
}
const immediately = () => ({ amount: 0, unit: 'hours' as const });
const later = (days: number) => ({ amount: days, unit: 'days' as const });
const variant = (body: string) => [{ id: 'a', body, weight: 100 }];
const end = (
  id: string,
  outcome: 'completed' | 'replied' | 'not_accepted' | 'manual' = 'completed'
): WorkflowStep => ({
  id,
  action: 'end',
  delayBefore: immediately(),
  config: { outcome }
});
type InviteConfig = {
  key: string;
  label: string;
  blurb: string;
  warmup?: 'view' | 'like' | 'follow';
  message?: string;
  followUp?: string;
};
function inviteTemplate(recipe: InviteConfig): WorkflowStarterRecipe {
  return {
    key: recipe.key,
    label: recipe.label,
    blurb: recipe.blurb,
    build(mint) {
      const steps: WorkflowStep[] = [];
      if (recipe.warmup) {
        const action =
          recipe.warmup === 'view'
            ? 'profile_view'
            : recipe.warmup === 'like'
              ? 'like_post'
              : 'follow';
        steps.push({ id: mint(), action, delayBefore: immediately(), config: {} });
      }
      const invite = mint();
      steps.push({
        id: invite,
        action: 'connection_request',
        delayBefore: steps.length ? later(1) : immediately(),
        config: { message: '' }
      });
      if (!recipe.message) {
        steps.push(end(mint()));
        return steps;
      }
      const accepted = mint(),
        message = mint(),
        noAccept = mint(),
        completed = mint();
      steps.push({
        id: accepted,
        action: 'monitor',
        delayBefore: immediately(),
        config: {
          condition: { kind: 'accepted', ofStepId: invite },
          timeout: later(10),
          pollEveryMinutes: 60,
          yesStepId: message,
          noStepId: noAccept
        }
      });
      steps.push({
        id: message,
        action: 'message',
        delayBefore: immediately(),
        config: { variants: variant(recipe.message), requiresAcceptedConnection: true }
      });
      if (recipe.followUp) {
        const reply = mint(),
          second = mint(),
          replied = mint();
        steps.push({
          id: reply,
          action: 'monitor',
          delayBefore: immediately(),
          config: {
            condition: { kind: 'replied', ofStepId: message },
            timeout: later(4),
            pollEveryMinutes: 60,
            yesStepId: replied,
            noStepId: second
          }
        });
        steps.push({
          id: second,
          action: 'message',
          delayBefore: immediately(),
          config: { variants: variant(recipe.followUp), requiresAcceptedConnection: true },
          nextStepId: completed
        });
        steps.push(end(replied, 'replied'));
      }
      steps.push(end(completed), end(noAccept, 'not_accepted'));
      return steps;
    }
  };
}
type ConnectedConfig = {
  key: string;
  label: string;
  blurb: string;
  message: string;
  followUp?: string;
};
function connectedTemplate(recipe: ConnectedConfig): WorkflowStarterRecipe {
  return {
    key: recipe.key,
    label: recipe.label,
    blurb: recipe.blurb,
    build(mint) {
      const connected = mint(),
        message = mint(),
        completed = mint(),
        excluded = mint();
      const steps: WorkflowStep[] = [
        {
          id: connected,
          action: 'condition',
          delayBefore: immediately(),
          config: { condition: { kind: 'connected' }, yesStepId: message, noStepId: excluded }
        },
        {
          id: message,
          action: 'message',
          delayBefore: immediately(),
          config: { variants: variant(recipe.message), requiresAcceptedConnection: false }
        }
      ];
      if (recipe.followUp) {
        const monitor = mint(),
          second = mint(),
          replied = mint();
        steps.push({
          id: monitor,
          action: 'monitor',
          delayBefore: immediately(),
          config: {
            condition: { kind: 'replied', ofStepId: message },
            timeout: later(5),
            pollEveryMinutes: 60,
            yesStepId: replied,
            noStepId: second
          }
        });
        steps.push({
          id: second,
          action: 'message',
          delayBefore: immediately(),
          nextStepId: completed,
          config: {
            variants: variant(recipe.followUp),
            requiresAcceptedConnection: false
          }
        });
        steps.push(end(replied, 'replied'));
      }
      steps.push(end(completed), end(excluded, 'manual'));
      return steps;
    }
  };
}
function emailTemplate(): WorkflowStarterRecipe {
  return {
    key: 'email-first-consent',
    label: 'Email first (verified sender)',
    blurb:
      'Email only when the lead has an address and the connected mailbox passes compliance and consent checks.',
    build(mint) {
      const eligible = mint(),
        mail = mint(),
        completed = mint(),
        notEligible = mint();
      return [
        {
          id: eligible,
          action: 'condition',
          delayBefore: immediately(),
          config: { condition: { kind: 'email_available' }, yesStepId: mail, noStepId: notEligible }
        },
        {
          id: mail,
          action: 'email',
          delayBefore: immediately(),
          config: {
            subject: 'Question about {{company}}',
            variants: variant(
              'Hi {{first_name|there}}, would it be useful to compare notes about your current priorities at {{company}}?'
            ),
            tracking: 'off',
            threaded: true
          }
        },
        end(completed),
        end(notEligible, 'manual')
      ];
    }
  };
}
function inmailTemplate(): WorkflowStarterRecipe {
  return {
    key: 'inmail-approval-first',
    label: 'InMail introduction (no paid fallback)',
    blurb:
      'InMail from an eligible seat without permitting any paid-credit fallback automatically.',
    build(mint) {
      const profile = mint(),
        mail = mint(),
        completed = mint(),
        notEligible = mint();
      return [
        {
          id: profile,
          action: 'condition',
          delayBefore: immediately(),
          config: { condition: { kind: 'open_profile' }, yesStepId: mail, noStepId: notEligible }
        },
        {
          id: mail,
          action: 'inmail',
          delayBefore: immediately(),
          config: {
            subject: 'Introduction for {{company}}',
            allowPaid: false,
            variants: variant(
              'Hi {{first_name|there}}, reaching out about a potential fit with {{company}}. Is this a useful topic to discuss?'
            )
          }
        },
        end(completed),
        end(notEligible, 'manual')
      ];
    }
  };
}
function manualTemplate(): WorkflowStarterRecipe {
  return {
    key: 'vip-human-review',
    label: 'High-value lead — personal handoff',
    blurb:
      'Visit and engage before a human writes and sends the first message. No unattended cold DM.',
    build(mint) {
      return [
        { id: mint(), action: 'profile_view', delayBefore: immediately(), config: {} },
        {
          id: mint(),
          action: 'manual_message',
          delayBefore: later(2),
          config: {
            suggestedTemplate:
              'Hi {{first_name|there}}, I looked at {{company}} and would like to introduce myself. Please personalize the reason before sending.'
          }
        },
        end(mint(), 'manual')
      ];
    }
  };
}

/** Different objectives and safe channel paths, not 14 cloned copies of the same five-touch. */
export const ADDITIONAL_WORKFLOW_STARTERS: readonly WorkflowStarterRecipe[] = [
  inviteTemplate({
    key: 'founder-introduction',
    label: 'Founder-to-founder introduction',
    blurb:
      'A view, no-note invitation, then a concise founder-to-founder question and one reply-gated follow-up.',
    warmup: 'view',
    message:
      'Thanks for connecting, {{first_name|there}}. What is the top priority for {{company}} this quarter?',
    followUp: 'Following up once, {{first_name|there}}. Happy to share context if this is timely.'
  }),
  inviteTemplate({
    key: 'partner-introduction',
    label: 'Partnership exploration',
    blurb: 'An invitation followed by a partnership question after acceptance.',
    message:
      'Hi {{first_name|there}}, would exploring potential collaboration with {{company}} make sense?'
  }),
  inviteTemplate({
    key: 'candidate-connection',
    label: 'Candidate introduction',
    blurb:
      'Make a connection before opening a recruiting conversation. No automatic claim about a vacancy.',
    warmup: 'view',
    message:
      'Thanks for connecting, {{first_name|there}}. Would you be open to hearing about relevant opportunities?'
  }),
  inviteTemplate({
    key: 'hiring-team',
    label: 'Hiring-team conversation',
    blurb: 'Engage with a hiring leader, then ask about their current team priorities.',
    warmup: 'follow',
    message:
      'Thanks for connecting, {{first_name|there}}. What are the hiring priorities at {{company}}?',
    followUp:
      'Closing the loop, {{first_name|there}}. Happy to reconnect if hiring becomes a priority.'
  }),
  inviteTemplate({
    key: 'post-engager',
    label: 'Post-engager follow-up',
    blurb:
      'Use with an explicitly sourced post-engager list. Like, connect, then follow up only after acceptance.',
    warmup: 'like',
    message:
      'Thanks for connecting, {{first_name|there}}. I appreciated your interest in the conversation.'
  }),
  inviteTemplate({
    key: 'community-first',
    label: 'Community-first introduction',
    blurb:
      'Follow the lead first, then invite with no note and ask for perspective after acceptance.',
    warmup: 'follow',
    message: 'Hi {{first_name|there}}, curious how the team at {{company}} approaches this topic.'
  }),
  inviteTemplate({
    key: 'simple-invite',
    label: 'No-pitch connection request',
    blurb: 'Just a single no-note connection request; no automatic unsolicited follow-up.',
    warmup: 'view'
  }),
  connectedTemplate({
    key: 'customer-feedback',
    label: 'Customer feedback interview',
    blurb: 'Only for confirmed LinkedIn connections. Ask for feedback and stop when answered.',
    message: 'Hi {{first_name|there}}, could I ask for brief feedback on your experience?',
    followUp: 'One follow-up, {{first_name|there}} — your feedback would help us improve.'
  }),
  connectedTemplate({
    key: 'warm-referral',
    label: 'Warm referral request',
    blurb: 'Ask a real connection for an introduction; do not send to unconnected leads.',
    message:
      'Hi {{first_name|there}}, would you feel comfortable suggesting who handles this at {{company}}?'
  }),
  connectedTemplate({
    key: 'event-reconnection',
    label: 'After-event reconnection',
    blurb: 'Use with known existing connections after an event. No invented claims of having met.',
    message: 'Hi {{first_name|there}}, following up after the event. What topics stood out for you?'
  }),
  connectedTemplate({
    key: 'account-nurture',
    label: 'Account nurture — reply aware',
    blurb: 'Ask existing connections a contextual question; skip the second note after a reply.',
    message: 'Hi {{first_name|there}}, checking whether this is a priority for {{company}}.',
    followUp: 'Following up once in case this is more relevant now, {{first_name|there}}.'
  }),
  emailTemplate(),
  inmailTemplate(),
  manualTemplate()
];
