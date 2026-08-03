import type { Group, Event, Place, Person, Tag } from '@/payload-types'
import { de } from '@/messages/de'

export function FilterBar({
  groups,
  events,
  places,
  people,
  tags,
  current,
}: {
  groups: Group[]
  events: Event[]
  places: Place[]
  people: Person[]
  tags: Tag[]
  current: Record<string, string>
}) {
  return (
    <form method="get" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'end', margin: '1rem 0' }}>
      <label>
        {de.archiv.filterJahr}
        <input type="number" name="jahr" defaultValue={current.jahr} />
      </label>
      <label>
        {de.archiv.filterGruppe}
        <select name="gruppe" defaultValue={current.gruppe}>
          <option value="">{de.archiv.alle}</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        {de.archiv.filterEreignis}
        <select name="ereignis" defaultValue={current.ereignis}>
          <option value="">{de.archiv.alle}</option>
          {events.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        {de.archiv.filterOrt}
        <select name="ort" defaultValue={current.ort}>
          <option value="">{de.archiv.alle}</option>
          {places.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        {de.archiv.filterPerson}
        <select name="person" defaultValue={current.person}>
          <option value="">{de.archiv.alle}</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        {de.archiv.filterTag}
        <select name="tag" defaultValue={current.tag}>
          <option value="">{de.archiv.alle}</option>
          {tags.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <button type="submit">{de.archiv.filtern}</button>
    </form>
  )
}
