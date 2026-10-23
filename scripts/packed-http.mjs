/** Real HTTP coverage for the generated clients extracted by smoke-dist.mjs. */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, request } from 'node:http'

export async function checkPackedHttp(cjs, esm) {
  const received = []
  const pending = []
  const responded = []
  const sockets = new Set()
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('error', () => res.destroy())
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString())
        const wire = { body, headers: req.headers, url: req.url, method: req.method }
        received.push(wire)
        const respond = () => {
          const status = Number(/^fail-(401|503)/.exec(body.variables.id)?.[1] ?? 200)
          res.writeHead(status, { 'Content-Type': 'application/json', 'X-Wire': req.headers['x-client'] })
          res.end(
            JSON.stringify(
              status === 200
                ? {
                    data: {
                      [body.operationName]: `${req.headers['x-client']}:${req.headers['x-call']}:${req.headers['x-prepared']}`,
                    },
                  }
                : { errors: [{ message: `synthetic ${status}` }] }
            )
          )
          responded.push(wire)
        }
        // Hold the first four requests until all clients arrive, then answer in reverse arrival order.
        if (received.length <= 4) {
          pending.push(respond)
          if (pending.length === 4) pending.reverse().forEach(send => send())
        } else respond()
      } catch (error) {
        res.destroy(error)
      }
    })
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  let deadline
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const url = `http://127.0.0.1:${server.address().port}/graphql`
    await Promise.race([
      exerciseClients(url),
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('packed HTTP smoke timed out')), 5000)
      }),
    ])
  } finally {
    clearTimeout(deadline)
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  }

  async function exerciseClients(url) {
    const customAttempts = []
    const transport =
      identity =>
      ({ url, body, headers, params }) =>
        new Promise((resolve, reject) => {
          customAttempts.push(identity)
          const target = new URL(url)
          Object.entries(params).forEach(([key, value]) => target.searchParams.set(key, String(value)))
          const req = request(target, { method: 'POST', headers: { ...headers, 'X-Transport': identity }, agent: false }, res => {
            const chunks = []
            res.on('data', chunk => chunks.push(chunk))
            res.on('error', reject)
            res.on('end', () => {
              try {
                resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(Buffer.concat(chunks).toString()) })
              } catch (error) {
                reject(error)
              }
            })
          })
          req.on('error', reject)
          req.end(JSON.stringify(body))
        })
    const clients = [
      cjs.createSmokeApi({ transport: transport('cjs') }),
      esm.createSmokeApi({ transport: transport('esm') }),
      cjs.smokeApi,
    ]
    const identities = ['cjs', 'esm', 'axios']
    const listeners = clients.map(() => [])
    const detach = []
    const listenerDone = clients.map(
      (client, index) =>
        new Promise(resolve => {
          client.setUrl(url)
          client.setHeader('X-Client', identities[index])
          client.setRetryConfig({ max: 2, unauthorized: true, before: () => assert.fail('unexpected retry hook') })
          detach.push(
            client.addRequestListener(async info => {
              await Promise.resolve()
              info.headers['X-Prepared'] = `${identities[index]}/${info.variables.id}`
            })
          )
          detach.push(
            client.addResponseListener(info => {
              if (info.variables.id.startsWith('concurrent-')) {
                listeners[index].push(info)
                if (listeners[index].length === (index === 0 ? 2 : 1)) resolve()
              }
            })
          )
        })
    )
    const selection = id => ({ __retry: false, __alias: 'wire', __args: { id }, __headers: { 'X-Call': id } })
    const expected = (identity, id) => `${identity}:${id}:${identity}/${id}`
    try {
      // Identical memo keys in different clients must reach their own transport and headers.
      const first = clients.map(client => client.queries.a.memo(selection('concurrent-shared')))
      first.push(clients[0].queries.a.raw(selection('concurrent-other')))
      const [cjsResult, esmResult, axiosResult, other] = await Promise.all(first)
      await Promise.all(listenerDone)
      assert.deepEqual(
        [cjsResult, esmResult, axiosResult],
        identities.map(id => expected(id, 'concurrent-shared'))
      )
      assert.equal(other.data, expected('cjs', 'concurrent-other'))
      assert.deepEqual(responded, received.slice(0, 4).reverse(), 'fixture must respond out of arrival order')
      assert.deepEqual(customAttempts.sort(), ['cjs', 'cjs', 'esm'], 'the default singleton must use actual Axios')
      listeners.forEach((seen, index) =>
        seen.forEach(info => {
          assert.equal(info.response.data.wire, expected(identities[index], info.variables.id))
          assert.equal(info.response.headers['x-wire'], identities[index])
        })
      )
      for (const [index, client] of clients.entries()) {
        for (let repeat = 0; repeat < 2; repeat++) {
          const before = received.length
          const result = await client.queries.a.raw(selection('concurrent-shared'))
          assert.equal(result.data, expected(identities[index], 'concurrent-shared'))
          assert.equal(received.length, before + 1, 'raw must bypass the primed memo entry')
        }
        for (const status of [401, 503]) {
          for (const endpoint of [client.queries.a, client.mutations.updateA]) {
            for (let repeat = 0; repeat < 2; repeat++) {
              const before = received.length
              const result = await endpoint.raw(selection(`fail-${status}`))
              assert.equal(result.status, status)
              assert.equal(result.outcome, 'failure')
              assert.equal(result.reason, 'http')
              assert.equal(received.length, before + 1, 'retry opt-out must make one HTTP attempt')
            }
          }
        }
      }
      assert.equal(received.length, 34)
      for (const wire of received) {
        assert.equal(wire.method, 'POST')
        assert.equal(wire.url, '/graphql?_q=wire')
        assert.equal(wire.headers['content-type'], 'application/json')
        assert.equal(wire.headers['x-transport'], wire.headers['x-client'] === 'axios' ? undefined : wire.headers['x-client'])
        assert.equal(wire.headers['x-call'], wire.body.variables.id)
        assert.equal(wire.headers['x-prepared'], `${wire.headers['x-client']}/${wire.body.variables.id}`)
        assert.equal(wire.body.operationName, 'wire')
        assert.ok(
          ['query wire($id: String) { wire:a(id:$id)  }', 'mutation wire($id: String) { wire:updateA(id:$id)  }'].includes(
            wire.body.query
          ),
          `unexpected serialized document: ${wire.body.query}`
        )
      }
      console.log('packed HTTP: 34 requests passed with isolated CJS/ESM clients and default Axios')
    } finally {
      detach.forEach(remove => remove())
    }
  }
}
