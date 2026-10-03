// The tracker editor: name, type, group, color, and the settings for the tracker's type.
import { useEffect, useRef, useState } from 'react';
import { useData } from '../../hooks';
import {
  COLORS, TYPE_HELP, TYPE_LABELS, defaultConfig, liveEntries, sortedTrackers, trackerProblem,
  type Tracker, type TrackerConfig, type TrackerType,
} from '../../lib/model';
import { archiveTracker, saveTrackerEdit } from '../../lib/actions';
import { unhandled } from '../../lib/util';
import { colorStyle } from '../../components/style';

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

/** The tracker's config from the form, keeping any settings the form doesn't show. */
function configFromFields(type: TrackerType, fields: ConfigFields, base: TrackerConfig): TrackerConfig {
  const lines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean);
  const numberOrNull = (text: string) => (text === '' ? null : Number(text));
  switch (type) {
    case 'rating':
    case 'episode':
      return { ...base, levels: lines(fields.levels) };
    case 'choice':
      return { ...base, options: lines(fields.options), multi: fields.multi };
    case 'number':
      return {
        ...base,
        unit: fields.unit.trim(),
        step: numberOrNull(fields.step) || 1,
        min: numberOrNull(fields.min),
        max: numberOrNull(fields.max),
      };
    case 'moment':
    case 'text':
      return base;
    default:
      return unhandled(type, base);
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
  const [group, setGroup] = useState(tracker.grp || '');
  const [color, setColor] = useState(tracker.color);
  // Switching type starts that type's settings from its defaults.
  const [baseConfig, setBaseConfig] = useState(tracker.config);
  const [fields, setFields] = useState(() => configFields(tracker.config));
  const [error, setError] = useState('');
  const nameInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isNew) nameInput.current?.focus();
  }, [isNew]);

  // A tracker's type is fixed once it has entries, since they were recorded in that type's shape.
  const typeLocked = !isNew && liveEntries(data).some(e => e.tracker_id === tracker.id);
  const existingGroups = [...new Set(sortedTrackers(data, null, { includeArchived: true }).map(t => t.grp).filter(Boolean))];
  const setField = <K extends keyof ConfigFields>(key: K, value: ConfigFields[K]) => setFields(f => ({ ...f, [key]: value }));

  const changeType = (next: TrackerType) => {
    setType(next);
    setBaseConfig(defaultConfig(next));
    setFields(configFields(defaultConfig(next)));
  };

  const save = async () => {
    const edited: Tracker = {
      ...tracker,
      name: name.trim(),
      type,
      grp: group.trim(),
      color,
      config: configFromFields(type, fields, baseConfig),
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

  return (
    <div id="editor">
      <div className="panel stack tracker-editor">
        <h3>{isNew ? 'New tracker' : 'Edit tracker'}</h3>

        <label className="field" htmlFor="edName">
          Name
          <input id="edName" ref={nameInput} value={name} autoComplete="off" onChange={e => setName(e.target.value)} />
        </label>

        <label className="field" htmlFor="edType">
          Type
          <select id="edType" value={type} disabled={typeLocked} onChange={e => changeType(e.target.value as TrackerType)}>
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

        <label className="field" htmlFor="edGrp">
          Group
          <input id="edGrp" list="grpList" value={group} placeholder="e.g. Symptoms" onChange={e => setGroup(e.target.value)} />
          <datalist id="grpList">
            {existingGroups.map(g => <option key={g} value={g!} />)}
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
          </div>
        </div>

        <TypeFields type={type} fields={fields} setField={setField} />

        <p className="small error-text" id="edErr">{error}</p>
        <div className="button-row">
          <button type="button" className="button primary" id="edSave" onClick={save}>Save</button>
          <button type="button" className="button" id="edCancel" onClick={onClose}>Cancel</button>
          {!isNew && <button type="button" className="button danger" id="edArchive" onClick={archive}>Archive</button>}
        </div>
      </div>
    </div>
  );
}

interface TypeFieldsProps {
  type: TrackerType;
  fields: ConfigFields;
  setField: <K extends keyof ConfigFields>(key: K, value: ConfigFields[K]) => void;
}

/** The editor fields specific to a tracker type. */
function TypeFields({ type, fields, setField }: TypeFieldsProps) {
  switch (type) {
    case 'rating':
      return (
        <label className="field" htmlFor="edLevels">
          Levels, lowest first, one per line (2–10)
          <textarea id="edLevels" rows={5} value={fields.levels} onChange={e => setField('levels', e.target.value)} />
        </label>
      );
    case 'episode':
      return (
        <label className="field" htmlFor="edLevels">
          Optional severity levels while it's running, one per line (leave empty for none)
          <textarea id="edLevels" rows={4} value={fields.levels} onChange={e => setField('levels', e.target.value)} />
        </label>
      );
    case 'number':
      return (
        <div className="field-grid">
          <label className="field" htmlFor="edUnit">
            Unit
            <input id="edUnit" value={fields.unit} placeholder="e.g. minutes" onChange={e => setField('unit', e.target.value)} />
          </label>
          <label className="field" htmlFor="edStep">
            Step
            <input id="edStep" type="number" step="any" value={fields.step} onChange={e => setField('step', e.target.value)} />
          </label>
          <label className="field" htmlFor="edMin">
            Minimum
            <input id="edMin" type="number" step="any" value={fields.min} onChange={e => setField('min', e.target.value)} />
          </label>
          <label className="field" htmlFor="edMax">
            Maximum
            <input id="edMax" type="number" step="any" value={fields.max} onChange={e => setField('max', e.target.value)} />
          </label>
        </div>
      );
    case 'choice':
      return (
        <>
          <label className="field" htmlFor="edOpts">
            Options, one per line
            <textarea id="edOpts" rows={5} value={fields.options} onChange={e => setField('options', e.target.value)} />
          </label>
          <label className="checkbox-field">
            <input type="checkbox" id="edMulti" checked={fields.multi}
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
