/**
 * Client half of the balance widget.
 *
 * Renders one compact chip beside Settings at the sidebar foot. The chip polls
 * the Host's same-origin balance routes (30s for the DeepSeek account, 2 min
 * for the 302.AI relay) and can be clicked to refresh both immediately. The
 * hover tooltip lists both balances. It never reads an account token or key.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-balance-widget',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement

    const BALANCE_ROUTE = '/plugins/dsh-balance-widget/balance'
    const RELAY_ROUTE = '/plugins/dsh-balance-widget/relay-balance'
    const APIYI_ROUTE = '/plugins/dsh-balance-widget/apiyi-balance'
    const STREAM_ROUTE = '/plugins/dsh-balance-widget/stream'

    /** Captured in `apply`; the component reads the live locale through it. */
    let localeService

    const DICT = {
      zh: {
        label: '余额',
        loading: '读取余额…',
        failed: '读取失败',
        signedOut: '未登录',
        recharged: '充值余额',
        bonus: '赠送余额',
        relayLabel: '302.AI 余额',
        relayLoading: '302.AI 余额：读取中…',
        relayDenied: '302.AI 余额：API Key 未开启余额权限',
        relayUnconfigured: '302.AI 余额：未配置 API Key',
        relayError: '302.AI 余额：读取失败',
        apiyiLabel: 'APIYI 余额',
        apiyiLoading: 'APIYI 余额：读取中…',
        apiyiUnconfigured: 'APIYI 余额：未配置个人访问令牌',
        apiyiDenied: 'APIYI 余额：令牌无效或无权限',
        apiyiError: 'APIYI 余额：读取失败',
        updated: '更新时间',
        menuDeepSeek: 'DeepSeek 余额',
        menuRelay: '302.AI 余额',
        menuTopUp: '去充值 →',
        menuRefresh: '刷新余额',
        refreshHint: '点击立即刷新；余额变化时自动更新',
        signInHint: '未登录 DeepSeek 账号，可在「设置 → 账户」登录',
        errorHint: '余额读取失败，点击重试',
      },
      en: {
        label: 'Balance',
        loading: 'Reading balance…',
        failed: 'Unavailable',
        signedOut: 'Sign in',
        recharged: 'Recharge balance',
        bonus: 'Bonus credit',
        relayLabel: '302.AI balance',
        relayLoading: '302.AI balance: reading…',
        relayDenied: '302.AI balance: API key lacks the balance permission',
        relayUnconfigured: '302.AI balance: no API key configured',
        relayError: '302.AI balance: unavailable',
        apiyiLabel: 'APIYI balance',
        apiyiLoading: 'APIYI balance: reading…',
        apiyiUnconfigured: 'APIYI balance: no personal access token configured',
        apiyiDenied: 'APIYI balance: token invalid or without permission',
        apiyiError: 'APIYI balance: unavailable',
        updated: 'Updated',
        menuDeepSeek: 'DeepSeek balance',
        menuRelay: '302.AI balance',
        menuTopUp: 'Top up →',
        menuRefresh: 'Refresh balances',
        refreshHint: 'Click to refresh; updates automatically when the balance changes',
        signInHint: 'Not signed in to DeepSeek. Go to Settings → Account.',
        errorHint: 'Balance unavailable, click to retry',
      },
    }

    const CURRENCY_SYMBOLS = { CNY: '¥', USD: '$' }

    /** Format a Host balance string the way the Platform Web client does. */
    function formatAmount(raw) {
      if (typeof raw !== 'string' && typeof raw !== 'number') return String(raw)
      const value = Number(raw)
      if (!Number.isFinite(value)) return String(raw)
      const magnitude = Math.abs(value)
      if (magnitude === 0) return '0.00'
      if (magnitude < 0.01) return value > 0 ? '<0.01' : '-0.01'
      return value.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    }

    /** Render one wallet list as `¥12.34 · $5.00`. */
    function walletText(wallets) {
      if (!Array.isArray(wallets) || wallets.length === 0) return ''
      return wallets
        .map((wallet) => {
          const symbol = CURRENCY_SYMBOLS[wallet.currency] || `${wallet.currency} `
          return `${symbol}${formatAmount(wallet.balance)}`
        })
        .join(' · ')
    }

    /** Active dictionary; defaults to the browser language when no service exists. */
    function currentLang() {
      const active = localeService && localeService.getSnapshot
        ? localeService.getSnapshot().active
        : undefined
      const tag = String(active || (typeof navigator !== 'undefined' ? navigator.language : '') || '')
      return tag.toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }

    /** Re-render the chip when the application language changes. */
    function useLang() {
      const [lang, setLang] = React.useState(currentLang)
      React.useEffect(() => {
        if (!localeService || typeof localeService.subscribe !== 'function') return undefined
        setLang(currentLang())
        return localeService.subscribe(() => setLang(currentLang()))
      }, [])
      return lang
    }

    /** One independent read that never rejects and keeps the previous value. */
    function useBalanceRead(route) {
      const [state, setState] = React.useState({ phase: 'loading' })
      const sequence = React.useRef(0)
      const refresh = React.useCallback(async () => {
        const id = ++sequence.current
        setState((previous) =>
          previous.phase === 'ready' || previous.phase === 'refreshing'
            ? { ...previous, phase: 'refreshing' }
            : { phase: 'loading' },
        )
        try {
          const response = await fetch(route, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          })
          const data = await response.json().catch(() => null)
          if (id !== sequence.current) return
          if (!response.ok || !data || data.status === 'error') {
            throw new Error(`HTTP ${response.status}`)
          }
          setState({ phase: 'ready', data })
        } catch (error) {
          if (id !== sequence.current) return
          setState({
            phase: 'error',
            message: error && error.message ? error.message : String(error),
          })
        }
      }, [route])
      // One initial read only: later updates arrive over the Host stream or a click.
      React.useEffect(() => {
        void refresh()
      }, [refresh])
      /** Apply a value pushed by the Host stream; it supersedes a pending poll. */
      const applyExternal = React.useCallback((data) => {
        if (!data) return
        sequence.current += 1
        setState({ phase: 'ready', data })
      }, [])
      return [state, refresh, applyExternal]
    }

    /** One row of the chip's right-click menu. */
    function MenuRow(props) {
      const [hover, setHover] = React.useState(false)
      const disabled = props.disabled === true
      return h(
        'div',
        {
          role: 'menuitem',
          tabIndex: disabled ? -1 : 0,
          'aria-disabled': disabled ? 'true' : undefined,
          onClick: disabled ? undefined : props.onClick,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '7px 10px',
            borderRadius: 7,
            cursor: disabled ? 'default' : 'pointer',
            background:
              hover && !disabled ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
            opacity: disabled ? 0.55 : 1,
          },
        },
        h(
          'span',
          { style: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 } },
          h(
            'span',
            {
              style: {
                fontSize: 12,
                color: 'var(--dsw-alias-label-primary)',
                whiteSpace: 'nowrap',
              },
            },
            props.label,
          ),
          props.hint
            ? h(
                'span',
                {
                  style: {
                    fontSize: 11,
                    color: 'var(--dsw-alias-label-secondary)',
                    whiteSpace: 'nowrap',
                  },
                },
                props.hint,
              )
            : null,
        ),
        h(
          'span',
          {
            style: {
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--dsw-alias-label-primary)',
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
            },
          },
          props.value || '',
        ),
      )
    }

    function BalanceChip(props) {
      const wide = props && props.wide !== false
      const lang = useLang()
      const t = DICT[lang] || DICT.en
      const [account, refreshAccount, applyAccountPush] = useBalanceRead(BALANCE_ROUTE)
      const [relay, refreshRelay, applyRelayPush] = useBalanceRead(RELAY_ROUTE)
      const [apiyi, refreshApiyi, applyApiyiPush] = useBalanceRead(APIYI_ROUTE)
      const [hovered, setHovered] = React.useState(false)
      const [menu, setMenu] = React.useState(null)
      const menuRef = React.useRef(null)

      React.useEffect(() => {
        if (typeof EventSource !== 'function') return undefined
        let closed = false
        let source = null
        let retry = null
        const connect = () => {
          if (closed) return
          let next
          try {
            next = new EventSource(STREAM_ROUTE)
          } catch {
            retry = setTimeout(connect, 5000)
            return
          }
          source = next
          next.onmessage = (event) => {
            let frame
            try {
              frame = JSON.parse(event.data)
            } catch {
              return
            }
            if (!frame || !frame.data) return
            if (frame.kind === 'account') applyAccountPush(frame.data)
            else if (frame.kind === 'relay') applyRelayPush(frame.data)
            else if (frame.kind === 'apiyi') applyApiyiPush(frame.data)
          }
          // A host reload ends the stream; EventSource does not always retry on
          // its own, so recreate a closed connection instead of staying stale.
          next.onerror = () => {
            if (closed) return
            if (next.readyState !== 2) return
            try {
              next.close()
            } catch {
              // already closed
            }
            if (source === next) source = null
            retry = setTimeout(connect, 5000)
          }
        }
        connect()
        return () => {
          closed = true
          if (retry) clearTimeout(retry)
          if (source) source.close()
        }
      }, [applyAccountPush, applyRelayPush, applyApiyiPush])

      // Dismiss the context menu on any outside interaction.
      React.useEffect(() => {
        if (!menu) return undefined
        const close = () => setMenu(null)
        const onPointerDown = (event) => {
          if (menuRef.current && menuRef.current.contains(event.target)) return
          close()
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') close()
        }
        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        document.addEventListener('scroll', close, true)
        window.addEventListener('resize', close)
        window.addEventListener('blur', close)
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
          document.removeEventListener('scroll', close, true)
          window.removeEventListener('resize', close)
          window.removeEventListener('blur', close)
        }
      }, [menu])

      /** Ask the Host to open the matching top-up page in the default browser. */
      const openTopup = React.useCallback((kind) => {
        setMenu(null)
        fetch(`/plugins/dsh-balance-widget/open-topup?kind=${kind}`, {
          method: 'POST',
          headers: { accept: 'application/json' },
        }).catch(() => {})
      }, [])

      const refresh = React.useCallback(() => {
        refreshAccount()
        refreshRelay()
        refreshApiyi()
      }, [refreshAccount, refreshRelay, refreshApiyi])

      const data = account.data
      const settled = account.phase === 'ready' || account.phase === 'refreshing'
      let amountText = '···'
      let dotColor = 'var(--dsw-alias-state-idle-primary)'
      const lines = []

      if (settled && data) {
        if (data.status === 'ready') {
          const wallets = walletText(data.wallets)
          const bonus = walletText(data.bonusWallets)
          amountText = wallets || '--'
          dotColor = 'var(--dsw-alias-state-success-primary)'
          lines.push(`${t.recharged}: ${wallets || '--'}`)
          if (bonus) lines.push(`${t.bonus}: ${bonus}`)
        } else if (data.status === 'signed-out') {
          amountText = t.signedOut
          dotColor = 'var(--dsw-alias-state-idle-primary)'
          lines.push(t.signInHint)
        } else {
          amountText = t.failed
          dotColor = 'var(--dsw-alias-state-warn-primary)'
          lines.push(t.errorHint)
        }
      } else if (account.phase === 'error') {
        amountText = t.failed
        dotColor = 'var(--dsw-alias-state-error-primary)'
        lines.push(`${t.errorHint}\n${account.message}`)
      } else {
        lines.push(t.loading)
      }

      const relayData = relay.data
      if (relay.phase === 'ready' || relay.phase === 'refreshing') {
        if (relayData && relayData.status === 'ready') {
          const symbol = CURRENCY_SYMBOLS[relayData.currency] || '$'
          lines.push(`${t.relayLabel}: ${symbol}${formatAmount(relayData.balance)}`)
        } else if (relayData && relayData.status === 'denied') {
          lines.push(t.relayDenied)
        } else if (relayData && relayData.status === 'unconfigured') {
          lines.push(t.relayUnconfigured)
        } else {
          lines.push(t.relayError)
        }
      } else if (relay.phase === 'error') {
        lines.push(t.relayError)
      } else {
        lines.push(t.relayLoading)
      }

      const apiyiData = apiyi.data
      if (apiyi.phase === 'ready' || apiyi.phase === 'refreshing') {
        if (apiyiData && apiyiData.status === 'ready') {
          const symbol = CURRENCY_SYMBOLS[apiyiData.currency] || '$'
          lines.push(`${t.apiyiLabel}: ${symbol}${formatAmount(apiyiData.balance)}`)
        } else if (apiyiData && apiyiData.status === 'denied') {
          lines.push(t.apiyiDenied)
        } else if (apiyiData && apiyiData.status === 'unconfigured') {
          lines.push(t.apiyiUnconfigured)
        } else {
          lines.push(t.apiyiError)
        }
      } else if (apiyi.phase === 'error') {
        lines.push(t.apiyiError)
      } else {
        lines.push(t.apiyiLoading)
      }

      const accountFetchedAt = settled && data ? data.fetchedAt : undefined
      const relayFetchedAt = relayData ? relayData.fetchedAt : undefined
      const apiyiFetchedAt = apiyiData ? apiyiData.fetchedAt : undefined
      const latestFetchedAt = Math.max(
        accountFetchedAt || 0,
        relayFetchedAt || 0,
        apiyiFetchedAt || 0,
      )
      if (latestFetchedAt > 0) {
        lines.push(
          `${t.updated}: ${new Date(latestFetchedAt).toLocaleTimeString(undefined, { hour12: false })}`,
        )
      }
      lines.push(t.refreshHint)
      const tooltip = lines.join('\n')

      const deepseekMenuValue =
        settled && data
          ? data.status === 'ready'
            ? walletText(data.wallets) || '--'
            : data.status === 'signed-out'
              ? t.signedOut
              : t.failed
          : '···'
      const relayMenuValue =
        (relay.phase === 'ready' || relay.phase === 'refreshing') && relayData
          ? relayData.status === 'ready'
            ? `${CURRENCY_SYMBOLS[relayData.currency] || '$'}${formatAmount(relayData.balance)}`
            : '—'
          : relay.phase === 'error'
            ? t.failed
            : '···'
      const apiyiMenuValue =
        (apiyi.phase === 'ready' || apiyi.phase === 'refreshing') && apiyiData
          ? apiyiData.status === 'ready'
            ? `${CURRENCY_SYMBOLS[apiyiData.currency] || '$'}${formatAmount(apiyiData.balance)}`
            : '—'
          : apiyi.phase === 'error'
            ? t.failed
            : '···'
      const deepseekTopUpReady = Boolean(settled && data && data.status === 'ready')
      const relayTopUpReady = Boolean(
        (relay.phase === 'ready' || relay.phase === 'refreshing') &&
          relayData &&
          relayData.status === 'ready',
      )
      const apiyiTopUpReady = Boolean(
        (apiyi.phase === 'ready' || apiyi.phase === 'refreshing') &&
          apiyiData &&
          apiyiData.status === 'ready',
      )
      const updatedText =
        latestFetchedAt > 0
          ? new Date(latestFetchedAt).toLocaleTimeString(undefined, { hour12: false })
          : ''

      const buttonStyle = {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: wide ? 6 : 0,
        height: 30,
        maxWidth: wide ? '100%' : 44,
        padding: wide ? '0 9px' : '0 2px',
        border: 'none',
        borderRadius: 8,
        background: hovered ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        font: 'inherit',
        fontSize: wide ? 12 : 10,
        lineHeight: '1',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        cursor: 'pointer',
        transition: 'background 120ms ease, color 120ms ease',
      }

      const chip = h(
        'button',
        {
          type: 'button',
          title: tooltip,
          'aria-label': tooltip.split('\n')[0],
          'aria-haspopup': 'menu',
          onClick: refresh,
          onContextMenu: (event) => {
            event.preventDefault()
            const menuWidth = 248
            const menuHeight = 250
            const viewportWidth = window.innerWidth || 1024
            const viewportHeight = window.innerHeight || 768
            setMenu({
              x: Math.max(8, Math.min(event.clientX, viewportWidth - menuWidth - 8)),
              y: Math.max(8, Math.min(event.clientY, viewportHeight - menuHeight - 8)),
            })
          },
          onMouseEnter: () => setHovered(true),
          onMouseLeave: () => setHovered(false),
          style: buttonStyle,
        },
        h('span', {
          'aria-hidden': true,
          style: {
            flex: '0 0 auto',
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: dotColor,
            opacity: account.phase === 'loading' ? 0.5 : 1,
          },
        }),
        wide
          ? h(
              'span',
              { style: { flex: '0 0 auto', color: 'var(--dsw-alias-label-secondary)' } },
              t.label,
            )
          : null,
        h(
          'span',
          {
            style: {
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              fontWeight: 600,
              color: 'var(--dsw-alias-label-primary)',
              fontVariantNumeric: 'tabular-nums',
            },
          },
          amountText,
        ),
      )

      const menuNode =
        menu && typeof document !== 'undefined'
          ? createPortal(
              h(
                'div',
                {
                  ref: menuRef,
                  role: 'menu',
                  'aria-label': t.label,
                  onContextMenu: (event) => event.preventDefault(),
                  style: {
                    position: 'fixed',
                    left: menu.x,
                    top: menu.y,
                    zIndex: 2147483000,
                    minWidth: 236,
                    padding: 5,
                    borderRadius: 10,
                    border: '1px solid var(--dsw-alias-border-l1)',
                    background: 'var(--dsw-alias-bg-overlay)',
                    boxShadow: '0 12px 32px rgba(0, 0, 0, 0.22)',
                    color: 'var(--dsw-alias-label-primary)',
                    font: 'inherit',
                    fontSize: 12,
                    userSelect: 'none',
                  },
                },
                h(MenuRow, {
                  label: t.menuDeepSeek,
                  hint: deepseekTopUpReady ? t.menuTopUp : undefined,
                  value: deepseekMenuValue,
                  disabled: !deepseekTopUpReady,
                  onClick: () => openTopup('deepseek'),
                }),
                h(MenuRow, {
                  label: t.menuRelay,
                  hint: relayTopUpReady ? t.menuTopUp : undefined,
                  value: relayMenuValue,
                  disabled: !relayTopUpReady,
                  onClick: () => openTopup('relay'),
                }),
                h(MenuRow, {
                  label: t.apiyiLabel,
                  hint: apiyiTopUpReady ? t.menuTopUp : undefined,
                  value: apiyiMenuValue,
                  disabled: !apiyiTopUpReady,
                  onClick: () => openTopup('apiyi'),
                }),
                h('div', {
                  style: {
                    height: 1,
                    margin: '4px 6px',
                    background: 'var(--dsw-alias-border-l1)',
                  },
                }),
                h(MenuRow, { label: t.menuRefresh, onClick: refresh }),
                updatedText
                  ? h(MenuRow, {
                      label: `${t.updated} ${updatedText}`,
                      disabled: true,
                    })
                  : null,
              ),
              document.body,
            )
          : null

      return h(React.Fragment, null, chip, menuNode)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        localeService = ctx.get('locale')
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'balance-widget',
              order: 10,
            },
            BalanceChip,
          ),
        )
      },
    }
  },
})
