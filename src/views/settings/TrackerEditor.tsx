import { useEffect, useRef, useState } from 'react';
import { useData } from '../../hooks';
import {
  TYPE_HELP, TYPE_LABELS, allTrackers, defaultConfig, liveEntries, trackerProblem,
  type Tracker, type TrackerConfig, type TrackerType,
} from '../../lib/model';
import { archiveTracker, deleteTracker, saveTrackerEdit } from '../../lib/actions';
import { unhandled } from '../../lib/util';
import { COLORS, colorStyle, isCustomColor } from '../../components/color';

/** The type-specific settings as the form shows them: everything is text, lists are one item per line. */
interface ConfigFields {
  levels: string;
  options: string;
  multi: boolean;
  unit: string;
  step: string;
  min: string;
  max: string;
}

type SetField = <K extends keyof ConfigFields>(key: K, value: ConfigFields[K]) => void;

function configFields(config: TrackerConfig): ConfigFields {
  return {
    levels: (config.levels || []).join('\n'),
    options: (config.options || []).join('\n'),
    multi: !!config.multi,
    unit: config.unit || '',
    step: String(config.step ?? 1),
    min: config.min == null ? '' : String(config.min),
    max: config.max == null ? '' : String(config.max),
  };
}

/** The settings a type has, from the form. */
function configFromFields(type: TrackerType, fields: ConfigFields): TrackerConfig {
  const lines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean);
  const numberOrNull = (text: string) => (text === '' ? null : Number(text));
  switch (type) {
    case 'rating':
    case 'episode':
      return { levels: lines(fields.levels) };
    case 'choice':
      return { options: lines(fields.options), multi: fields.multi };
    case 'number':
      return {
        unit: fields.unit.trim(),
        step: numberOrNull(fields.step) || 1,
        min: numberOrNull(fields.min),
        max: numberOrNull(fields.max),
      };
    case 'moment':
    case 'text':
      return {};
    default:
      return unhandled(type, {});
  }
}

interface Props {
  tracker: Tracker;
  isNew: boolean;
  onClose: () => void;
}

export function TrackerEditor({ tracker, isNew, onClose }: Props) {
  const data = useData();
  const [name, setName] = useState(tracker.name);
  const [type, setType] = useState(tracker.type);
  const [group, setGroup] = useState(tracker.group_name || '');
  const [color, setColor] = useState(tracker.color);
  const [fields, setFields] = useState(() => configFields(tracker.config));
  const [error, setError] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isNew) nameInput.current?.focus();
  }, [isNew]);

  // A tracker's type is fixed once it has entries, since they were recorded in that type's shape.
  const entryCount = isNew ? 0 : liveEntries(data).filter(e => e.tracker_id === tracker.id).length;
  const typeLocked = entryCount > 0;
  const existingGroups = [...new Set(allTrackers(data).map(t => t.group_name).filter((g): g is string => !!g))];
  const setField: SetField = (key, value) => setFields(f => ({ ...f, [key]: value }));

  // Switching type starts that type's settings from its defaults.
  const changeType = (next: TrackerType) => {
    setType(next);
    setFields(configFields(defaultConfig(next)));
  };

  const save = async () => {
    const edited: Tracker = {
      ...tracker,
      name: name.trim(),
      type,
      group_name: group.trim(),
      color,
      // Keeps any settings this form doesn't know about (from a newer version of the app), and its place in a row.
      config: {
        ...(type === tracker.type ? tracker.config : { new_row: tracker.config.new_row }),
        ...configFromFields(type, fields),
      },
    };
    const problem = trackerProblem(edited);
    if (problem) {
      setError(problem);
      return;
    }
    if (await saveTrackerEdit(edited)) onClose();
  };

  const archive = async () => {
    if (await archiveTracker(tracker.id)) onClose();
  };

  const remove = async () => {
    if (await deleteTracker(tracker.id)) onClose();
  };

  return (
    <div className="panel stack tracker-editor">
      <h3>{isNew ? 'New tracker' : 'Edit tracker'}</h3>

      <label className="field">
        Name
        <input id="editor-name" ref={nameInput} value={name} autoComplete="off" onChange={e => setName(e.target.value)} />
      </label>

      <label className="field">
        Type
        <select id="editor-type" value={type} disabled={typeLocked} onChange={e => changeType(e.target.value as TrackerType)}>
          {(Object.keys(TYPE_LABELS) as TrackerType[]).map(t => (
            <option key={t} value={t}>{TYPE_LABELS[t]}</option>
          ))}
        </select>
      </label>
      <p className="small muted">
        {typeLocked
          ? "The type can't change once a tracker has entries. Archive it and make a new one instead."
          : TYPE_HELP[type]}
      </p>

      <label className="field">
        Group
        <input id="editor-group" list="editor-groups" value={group} placeholder="e.g. Symptoms" onChange={e => setGroup(e.target.value)} />
        <datalist id="editor-groups">
          {existingGroups.map(g => <option key={g} value={g} />)}
        </datalist>
      </label>

      <div>
        Color
        <div className="swatches">
          {COLORS.map(c => (
            <button
              key={c}
              type="button"
              data-color={c}
              style={colorStyle(c)}
              aria-label={c}
              aria-pressed={color === c}
              onClick={() => setColor(c)}
            />
          ))}
          {/* The phone's own color picker, behind a rainbow swatch that shows the color once picked. */}
          <label className={isCustomColor(color) ? 'custom-color is-selected' : 'custom-color'}
            style={isCustomColor(color) ? colorStyle(color) : undefined}>
            <input type="color" id="editor-custom-color" aria-label="Custom color"
              value={isCustomColor(color) ? color : '#888888'} onChange={e => setColor(e.target.value)} />
          </label>
        </div>
      </div>

      <TypeFields type={type} fields={fields} setField={setField} />

      <p className="small error-text" id="editor-error">{error}</p>
      <div className="button-row">
        <button type="button" className="button primary" id="editor-save" onClick={save}>Save</button>
        <button type="button" className="button" id="editor-cancel" onClick={onClose}>Cancel</button>
        {!isNew && <button type="button" className="button" id="editor-archive" onClick={archive}>Archive</button>}
        {!isNew && (
          <button type="button" className="button danger" id="editor-delete" onClick={() => setConfirmingDelete(true)}>Delete</button>
        )}
      </div>
      {confirmingDelete && (
        <div className="notice stack">
          <p>
            <b>Delete {tracker.name} for good?</b>{' '}
            {entryCount > 0 && `Its ${entryCount} ${entryCount === 1 ? 'entry goes' : 'entries go'} with it, `}
            {entryCount > 0 ? 'on' : 'On'} this device and everywhere you're signed in. This can't be undone.
            To hide it but keep its history, archive it instead.
          </p>
          <div className="button-row">
            <button type="button" className="button danger" id="editor-delete-confirm" onClick={remove}>Delete for good</button>
            <button type="button" className="button" onClick={() => setConfirmingDelete(false)}>Keep it</button>
          </div>
        </div>
      )}
    </div>
  );
}

interface TypeFieldsProps {
  type: TrackerType;
  fields: ConfigFields;
  setField: SetField;
}

/** The editor fields specific to a tracker type. */
function TypeFields({ type, fields, setField }: TypeFieldsProps) {
  switch (type) {
    case 'rating':
      return (
        <label className="field">
          Levels, lowest first, one per line (2–10)
          <textarea id="editor-levels" rows={5} value={fields.levels} onChange={e => setField('levels', e.target.value)} />
        </label>
      );
    case 'episode':
      return (
        <label className="field">
          Optional severity levels while it's running, one per line (leave empty for none)
          <textarea id="editor-levels" rows={4} value={fields.levels} onChange={e => setField('levels', e.target.value)} />
        </label>
      );
    case 'number':
      return (
        <div className="field-grid">
          <label className="field">
            Unit
            <input id="editor-unit" value={fields.unit} placeholder="e.g. minutes" onChange={e => setField('unit', e.target.value)} />
          </label>
          <label className="field">
            Step
            <input id="editor-step" type="number" step="any" value={fields.step} onChange={e => setField('step', e.target.value)} />
          </label>
          <label className="field">
            Minimum
            <input id="editor-min" type="number" step="any" value={fields.min} onChange={e => setField('min', e.target.value)} />
          </label>
          <label className="field">
            Maximum
            <input id="editor-max" type="number" step="any" value={fields.max} onChange={e => setField('max', e.target.value)} />
          </label>
        </div>
      );
    case 'choice':
      return (
        <>
          <label className="field">
            Options, one per line
            <textarea id="editor-options" rows={5} value={fields.options} onChange={e => setField('options', e.target.value)} />
          </label>
          <label className="checkbox-field">
            <input type="checkbox" id="editor-multi" checked={fields.multi}
              onChange={e => setField('multi', e.target.checked)} />
            Allow more than one
          </label>
        </>
      );
    case 'moment':
    case 'text':
      return null; // nothing to set up
    default:
      return unhandled(type, null);
  }
}
