// The Check in view: one question per check-in tracker, grouped. The draft lives in App,
// so answers survive switching tabs until they're saved.
import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { useData } from '../hooks';
import { toDateTimeInputValue, unhandled } from '../lib/util';
import { CHECKIN_TYPES, groupTrackers, sortedTrackers, type Tracker } from '../lib/model';
import { saveCheckin, type Answer } from '../lib/actions';
import { colorStyle } from '../components/style';

export interface CheckinDraft {
  answers: Record<string, Answer>; // trackerId -> answer
  time: string;                    // datetime-local value
}

export const emptyCheckin: CheckinDraft = { answers: {}, time: '' };

interface Props {
  draft: CheckinDraft;
  onChange: Dispatch<SetStateAction<CheckinDraft>>;
  onSaved: (time: number) => void;
}

export function CheckinView({ draft, onChange, onSaved }: Props) {
  const data = useData();
  const groups = groupTrackers(sortedTrackers(data, CHECKIN_TYPES));

  // Each visit starts at the current time, unless a time was already chosen for this draft.
  useEffect(() => {
    onChange(d => (d.time ? d : { ...d, time: toDateTimeInputValue(Date.now()) }));
  }, [onChange]);

  const setAnswer = (trackerId: string, answer: Answer) =>
    onChange(d => ({ ...d, answers: { ...d.answers, [trackerId]: answer } }));

  const save = async () => {
    const time = await saveCheckin(draft.answers, draft.time);
    if (time != null) onSaved(time);
  };

  return (
    <section id="view-checkin" className="stack">
      <div className="panel">
        <label className="field" htmlFor="ciTime">
          When
          <input
            type="datetime-local"
            id="ciTime"
            value={draft.time}
            onChange={e => {
              const time = e.target.value;
              onChange(d => ({ ...d, time }));
            }}
          />
        </label>
      </div>
      <div id="ciGroups" className="stack">
        {groups.length ? (
          groups.map(([group, trackers]) => (
            <section key={group}>
              <h2>{group}</h2>
              <div className="panel">
                {trackers.map(tracker => (
                  <Question
                    key={tracker.id}
                    tracker={tracker}
                    answer={draft.answers[tracker.id] ?? null}
                    onAnswer={answer => setAnswer(tracker.id, answer)}
                  />
                ))}
              </div>
            </section>
          ))
        ) : (
          <p className="empty-note">No check-in questions yet. Add a Rating, Number, Choices or Note tracker in Settings.</p>
        )}
      </div>
      <button className="button primary full-width" id="ciSave" type="button" onClick={save}>Save check-in</button>
      <p className="muted small">Every question is optional. Only what you answer is saved.</p>
    </section>
  );
}

interface QuestionProps {
  tracker: Tracker;
  answer: Answer;
  onAnswer: (answer: Answer) => void;
}

function Question({ tracker, answer, onAnswer }: QuestionProps) {
  const levels = (tracker.config.levels || []).filter(Boolean);
  const pickedLabel = tracker.type === 'rating' && typeof answer === 'number' ? levels[answer - 1] : '';
  return (
    <div className="question">
      <div className="question-header">
        <h3>{tracker.name}</h3>
        <span className="question-answer">{pickedLabel}</span>
      </div>
      <AnswerInput tracker={tracker} answer={answer} onAnswer={onAnswer} levels={levels} />
    </div>
  );
}

function AnswerInput({ tracker, answer, onAnswer, levels }: QuestionProps & { levels: string[] }) {
  switch (tracker.type) {
    case 'rating':
      // Tapping the picked level again clears the answer.
      return (
        <>
          <div className="rating-scale" style={colorStyle(tracker.color)}>
            {levels.map((label, i) => (
              <button
                key={i}
                type="button"
                data-value={i + 1}
                aria-pressed={answer === i + 1}
                aria-label={label}
                title={label}
                onClick={() => onAnswer(answer === i + 1 ? null : i + 1)}
              >
                {i + 1}
              </button>
            ))}
          </div>
          <div className="rating-ends">
            <span>{levels[0] || ''}</span>
            <span>{levels[levels.length - 1] || ''}</span>
          </div>
        </>
      );

    case 'number': {
      const { min, max, step, unit } = tracker.config;
      return (
        <div className="number-row">
          <input
            type="number"
            inputMode="decimal"
            id={`checkin-number-${tracker.id}`}
            value={answer == null ? '' : String(answer)}
            min={min ?? undefined}
            max={max ?? undefined}
            step={step || 'any'}
            aria-label={tracker.name}
            onChange={e => onAnswer(e.target.value === '' ? null : e.target.value)}
          />
          <span className="muted">{unit || ''}</span>
        </div>
      );
    }

    case 'choice': {
      const picked = Array.isArray(answer) ? answer : [];
      const options = (tracker.config.options || []).filter(Boolean);
      // With multi off, picking an option replaces the previous one.
      const toggle = (option: string) => {
        if (picked.includes(option)) onAnswer(picked.filter(o => o !== option));
        else onAnswer(tracker.config.multi ? [...picked, option] : [option]);
      };
      return (
        <div className="chip-list" style={colorStyle(tracker.color)}>
          {options.map(option => (
            <button
              key={option}
              type="button"
              className="chip"
              aria-pressed={picked.includes(option)}
              onClick={() => toggle(option)}
            >
              {option}
            </button>
          ))}
        </div>
      );
    }

    case 'text':
      return (
        <textarea
          id={`checkin-text-${tracker.id}`}
          aria-label={tracker.name}
          placeholder="Optional"
          value={typeof answer === 'string' ? answer : ''}
          onChange={e => onAnswer(e.target.value)}
        />
      );

    case 'episode':
    case 'moment':
      return null; // tapped on Today, not asked in a check-in

    default:
      return unhandled(tracker.type, null);
  }
}
