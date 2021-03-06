import moment from 'moment'
import Promise from 'bluebird'
import retry from 'bluebird-retry'
import _ from 'lodash'

import DB from './db'

let knex = null
let bp = null

let schedulingLock = false
let sendingLock = false

const intervalBase = process.env.NODE_ENV === 'production'
  ? 60 * 1000
  : 1000

const emitChanged = _.throttle(() => {
  bp && bp.events.emit('broadcast.changed')
}, 1000)

function scheduleToOutbox() {
  if (!knex || schedulingLock) {
    return
  }

  schedulingLock = true
  knex('broadcast_schedules')
  .where({ outboxed: 0 })
  .andWhere(function() {
    this.where(function() {
      this.whereNotNull('ts')
      .andWhere(knex.raw("julianday('now', '+5 minutes', 'utc') >= julianday(ts/1000, 'unixepoch', 'utc')"))
    })
    .orWhere(function() {
      this.whereNull('ts')
      .andWhere(knex.raw("julianday('now', '+14 hours', '+5 minutes', 'utc') >= julianday(date_time, 'utc')"))
    })
  })
  .then(schedules => {
    return Promise.map(schedules, (schedule) => {
      const time = schedule.ts
        ? schedule.ts
        : moment(schedule.date_time + '+00', 'YYYY-MM-DD HH:mmZ').format('x') + ' - (timezone * 3600000)'

      return knex.raw(`insert into broadcast_outbox (userId, scheduleId, ts)
        select userId, ?, ?
        from (select timezone, id as userId from users)`, [schedule.id, knex.raw(time)])
      .then(() => {
        return knex('broadcast_outbox')
        .where({ scheduleId: schedule.id })
        .select(knex.raw('count(*) as count'))
        .then().get(0).then(({ count }) => {
          return knex('broadcast_schedules')
          .where({ id: schedule.id })
          .update({ outboxed: 1, total_count: count })
          .then(() => {
            bp.logger.info('[broadcast] Scheduled broadcast #'
            + schedule.id, '. [' + count + ' messages]')

            if (schedule.filters && JSON.parse(schedule.filters).length > 0) {
              bp.logger.info('[broadcast] Filters found on broadcast #' +
                schedule.id, '. Filters are applied at sending time.')
            }

            emitChanged()
          })
        })
      })
    })
  })
  .finally(() => {
    schedulingLock = false
  })
}

const _sendBroadcast = Promise.method(row => {
  
  var dropPromise = Promise.resolve(false)

  if (row.filters) {
    dropPromise = Promise.mapSeries(JSON.parse(row.filters), filter => {
      let fnBody = filter.trim()
      if (!/^return /i.test(fnBody)) {
        fnBody = 'return ' + fnBody
      }

      const fn = new Function('bp', 'userId', 'platform', fnBody)
      return Promise.method(fn)(bp, row.userId, row.platform)
    })
    .then(values => {
      return _.some(values, v => {
        if (v !== true && v !== false) {
          bp.logger.warn('[broadcast] Filter returned something other ' +
            'than a boolean (or a Promise of a boolean)')
        }

        return typeof(v) !== 'undefined' && v !== null && v !== true
      })
    })
  }

  return dropPromise.then(drop => {
    if (drop) {
      bp.logger.debug('[broadcast] Drop sending #' + row.scheduleId 
        + ' to user: ' + row.userId + '. Reason = Filters')
      return
    }

    if (row.type === 'text') {
      bp.middlewares.sendOutgoing({
        platform: row.platform,
        type: 'text',
        text: row.text,
        raw: {
          to: row.userId,
          message: row.text
        }
      })
    } else {
      const fn = new Function('bp', 'userId', 'platform', row.text)
      return fn(bp, row.userId, row.platform)
    }
  })
})

function sendBroadcasts() {
  if (!knex || sendingLock) {
    return
  }

  sendingLock = true

  knex('broadcast_outbox')
  .where(knex.raw("julianday(broadcast_outbox.ts/1000, 'unixepoch', 'utc') <= julianday('now', 'utc')"))
  .join('users', 'users.id', 'broadcast_outbox.userId')
  .join('broadcast_schedules', 'scheduleId', 'broadcast_schedules.id')
  .limit(1000)
  .select([
    'users.userId as userId',
    'users.platform as platform',
    'broadcast_schedules.text as text',
    'broadcast_schedules.type as type',
    'broadcast_schedules.id as scheduleId',
    'broadcast_schedules.filters as filters',
    'broadcast_outbox.ts as sendTime',
    'broadcast_outbox.userId as scheduleUser'
  ])
  .then(rows => {
    let abort = false
    return Promise.mapSeries(rows, row => {
      if (abort) { return }
      return retry(() => _sendBroadcast(row), {
        max_tries: 3,
        interval: 1000,
        backoff: 3
      })
      .then(() => {
        return knex('broadcast_outbox')
        .where({ userId: row.scheduleUser, scheduleId: row.scheduleId })
        .delete()
        .then(() => {
          knex('broadcast_schedules')
          .where({ id: row.scheduleId })
          .update({ sent_count: knex.raw('sent_count + 1') })
          .then(() => emitChanged())
        })
      })
      .catch(err => {
        abort = true

        bp.logger.error('[broadcast] Broadcast #' + row.scheduleId +
          ' failed. Broadcast aborted. Reason: ' + err.message)

        bp.notifications.send({
          level: 'error',
          message: 'Broadcast #' + row.scheduleId + ' failed.'
          + ' Please check logs for the reason why.',
          url: '/logs'
        })

        return knex('broadcast_schedules')
        .where({ id: row.scheduleId })
        .update({ errored: true })
        .then(() => {
          return knex('broadcast_outbox')
          .where({ scheduleId: row.scheduleId })
          .delete()
          .then(() => emitChanged())
        })
      })
    })
  })
  .finally(() => {
    sendingLock = false
  })
}

module.exports = (botpress) => {
  bp = botpress

  bp.db.get()
  .then(k => {
    const { initialize } = DB(k)
    knex = k
    initialize()
  })

  setInterval(scheduleToOutbox, 2 * intervalBase)
  setInterval(sendBroadcasts, 10 * intervalBase)
}

// SCHEDULING (Every 1m) --> Exclusive lock
// TODO Look for outboxed + near or past
// outbox them with good timezone

// SENDING (every 1m) --> Exclusive lock
// TODO Look for past outboxed
// Send them
