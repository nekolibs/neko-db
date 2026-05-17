import { Button, Card, ScrollView, StatePresenter, Text, TopBar, View } from '@neko-os/ui'
import { useNavigation } from '@react-navigation/native'
import { useSQLiteContext } from 'expo-sqlite'
import { useEffect, useState } from 'react'

import { getModel } from '../models'

export function ModelDataView({ route: { params } }) {
  const db = useSQLiteContext()
  const { goBack } = useNavigation()
  const modelName = params?.model
  const model = getModel(modelName)

  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!model) {
      setError(`Model "${modelName}" not found`)
      setLoading(false)
      return
    }

    let query = model.query()
    for (const [name, field] of Object.entries(model.fields)) {
      if (field.type === 'belongsTo') query = query.preload(name)
    }

    query
      .all(db)
      .then(setRows)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [modelName])

  return (
    <View flex bg="mainBG">
      <TopBar
        title={modelName}
        subtitle={!loading && !error ? `${rows.length} row(s)` : undefined}
        left={<Button icon="arrow-left-s-line" ratio={1} mainBG onPress={goBack} xs />}
        bg="overlayBG"
      />

      <StatePresenter loading={loading} error={error} empty={!rows.length}>
        <ScrollView padding="md" gap="md">
          {rows.map((row, index) => (
            <Card key={row.id ?? index} bg="overlayBG" padding="md">
              <Text xs style={{ fontFamily: 'monospace' }}>
                {JSON.stringify(row, null, 2)}
              </Text>
            </Card>
          ))}
        </ScrollView>
      </StatePresenter>
    </View>
  )
}
