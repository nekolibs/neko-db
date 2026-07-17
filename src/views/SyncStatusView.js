import { SafeAreaView, Button, Card, ScrollView, StatePresenter, Tag, Text, TopBar, View } from '@neko-os/ui'
import { useNavigation } from '@react-navigation/native'

import { useSync, useSyncCursors } from '../sync'

const STATUS = {
  syncing: { color: 'primary', label: 'Syncing…', loading: true },
  ok: { color: 'green', label: 'Synced', fill: true },
  error: { color: 'red', label: 'Error', fill: true },
  idle: { color: 'gray', label: 'Never run' },
}

function formatDate(iso) {
  if (!iso) return null
  const d = new Date(iso)
  return isNaN(d.getTime()) ? iso : d.toLocaleString()
}

function SyncRow({ row, last }) {
  const state = row.running ? 'syncing' : row.status
  const date = formatDate(row.at)

  return (
    <View row centerV gap="md" padding="md" borderB={!last}>
      <View flex gap="xxs">
        <Text>{row.id}</Text>
        {state === 'error' ? (
          <Text xs color="red">
            {row.lastError}
            {row.errorCount > 1 ? ` ×${row.errorCount}` : ''}
          </Text>
        ) : null}
      </View>

      <View toRight gap="xxs">
        <Tag {...STATUS[state]} />
        {state !== 'syncing' && date ? (
          <Text xxs text3>
            {date}
          </Text>
        ) : null}
      </View>
    </View>
  )
}

function Group({ title, rows }) {
  if (!rows.length) return null

  return (
    <View gap="sm">
      <Text sm strong text2>
        {title}
      </Text>
      <Card bg="overlayBG" padding={0}>
        {rows.map((row, index) => (
          <SyncRow key={row.key} row={row} last={index === rows.length - 1} />
        ))}
      </Card>
    </View>
  )
}

// Per-operation sync status. Rows come fully derived from useSyncCursors (durable status +
// date from _sync_cursors, plus live "running"); the header refresh runs a full sync so the
// rows can be watched updating live.
export function SyncStatusView() {
  const { goBack } = useNavigation()
  const { rows, syncing } = useSyncCursors()
  const { sync } = useSync()

  const pushes = rows.filter((row) => row.kind === 'push')
  const pulls = rows.filter((row) => row.kind === 'pull')

  return (
    <View flex bg="mainBG">
      <TopBar
        title="Sync status"
        subtitle={`${rows.length} operation(s)`}
        bg="overlayBG"
        left={<Button icon="arrow-left-s-line" ratio={1} mainBG onPress={goBack} xs />}
      />
      <View flex>
        <StatePresenter empty={!rows.length} emptyTitle="No sync operations registered">
          <ScrollView padding="md">
            <View gap="lg">
              <Group title="Pushes" rows={pushes} />
              <Group title="Pulls" rows={pulls} />
            </View>
          </ScrollView>
        </StatePresenter>
      </View>

      <SafeAreaView bg="overlayBG" padding="md" edges={['bottom']} borderT>
        <Button
          icon="refresh-line"
          disabled={syncing}
          outline
          onPress={() => sync()}
          loading={syncing}
          label="Start Sync"
        />
      </SafeAreaView>
    </View>
  )
}
