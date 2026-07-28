from playwright.sync_api import sync_playwright
import json, time

LOG_PATH = '/workspace/test_logs.txt'
SHOT_INITIAL = '/workspace/test_initial.png'
SHOT_HOT = '/workspace/test_hot.png'
SHOT_PAGE3 = '/workspace/test_page3.png'

def main():
    logs = []
    def log(msg):
        line = f"{time.strftime('%H:%M:%S')} {msg}"
        print(line)
        logs.append(line)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1280, 'height': 900})
        page = context.new_page()

        page.on('console', lambda msg: logs.append(f"[console.{msg.type}] {msg.text}"))
        page.on('pageerror', lambda err: logs.append(f"[pageerror] {err}"))

        page.goto('http://localhost:8082/index.html')
        try:
            page.wait_for_load_state('networkidle', timeout=30000)
        except Exception as e:
            log(f'wait networkidle timeout: {e}')
        log('networkidle reached')

        # 给 JS 初始化 / 数据拉取 5 秒缓冲
        page.wait_for_timeout(5000)
        page.screenshot(path=SHOT_INITIAL, full_page=True)
        log(f'saved initial screenshot: {SHOT_INITIAL}')

        # 切换到 热门股票 tab
        hot_tab = page.locator('#tabHot')
        if hot_tab.count():
            log('clicking #tabHot')
            hot_tab.click()
            page.wait_for_timeout(3000)
        else:
            log('#tabHot not found')
        page.screenshot(path=SHOT_HOT, full_page=True)
        log(f'saved hot tab screenshot: {SHOT_HOT}')

        hot_text = ''
        hot_content = page.locator('#hotContent')
        if hot_content.count():
            hot_text = hot_content.inner_text(timeout=5000)
            log(f'hotContent inner_text length={len(hot_text)}')
            log('hotContent first 500 chars: ' + hot_text[:500].replace('\n', ' | '))
        else:
            log('#hotContent not found')

        # 翻页到第 3 页（page-dot 索引 2）
        dots = page.locator('.page-dot')
        if dots.count() >= 3:
            log('clicking page-dot index 2')
            dots.nth(2).click()
            page.wait_for_timeout(3000)
        else:
            log(f'page-dot count={dots.count()}')
        page.screenshot(path=SHOT_PAGE3, full_page=True)
        log(f'saved page3 screenshot: {SHOT_PAGE3}')

        page3_text = ''
        page3_content = page.locator('#hotContent3')
        if page3_content.count():
            page3_text = page3_content.inner_text(timeout=5000)
            log(f'hotContent3 inner_text length={len(page3_text)}')
            log('hotContent3 first 500 chars: ' + page3_text[:500].replace('\n', ' | '))
        else:
            log('#hotContent3 not found')

        # 额外检查 早盘竞价 tab 的 page3
        auction_tab = page.locator('#tabAuction')
        if auction_tab.count():
            log('clicking #tabAuction')
            auction_tab.click()
            page.wait_for_timeout(2000)
            if dots.count() >= 3:
                dots.nth(2).click()
                page.wait_for_timeout(3000)
            page3_auc_text = ''
            auc3 = page.locator('#auctionContent3')
            if auc3.count():
                page3_auc_text = auc3.inner_text(timeout=5000)
                log(f'auctionContent3 inner_text length={len(page3_auc_text)}')
                log('auctionContent3 first 500 chars: ' + page3_auc_text[:500].replace('\n', ' | '))
            else:
                log('#auctionContent3 not found')

        browser.close()

    with open(LOG_PATH, 'w', encoding='utf-8') as f:
        f.write('\n'.join(logs))
    log(f'wrote logs to {LOG_PATH}')

if __name__ == '__main__':
    main()
