from playwright.sync_api import sync_playwright
import json

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto('http://localhost:8080/index.html')
    page.wait_for_load_state('networkidle')
    page.wait_for_timeout(2000)

    # 截图
    page.screenshot(path='/tmp/auction_initial.png', full_page=True)

    # 检查 auctionBoard
    board = page.locator('#auctionBoard')
    print('auctionBoard exists:', board.count() > 0)
    print('auctionBoard class:', board.get_attribute('class') if board.count() > 0 else 'N/A')
    print('auctionBoard HTML:', board.inner_html()[:2000] if board.count() > 0 else 'N/A')

    # 检查标题栏
    header = page.locator('#auctionHeader')
    print('auctionHeader exists:', header.count() > 0)
    if header.count() > 0:
        print('header text:', header.inner_text())

    # 检查 swipe container
    swipe = page.locator('#auctionSwipeContainer')
    print('auctionSwipeContainer exists:', swipe.count() > 0)
    if swipe.count() > 0:
        print('swipe display:', swipe.evaluate('el => getComputedStyle(el).display'))

    # 检查 Page1
    page1 = page.locator('#auctionPage1')
    print('auctionPage1 exists:', page1.count() > 0)
    if page1.count() > 0:
        print('page1 display:', page1.evaluate('el => getComputedStyle(el).display'))
        print('page1 HTML:', page1.inner_html()[:1500])

    # 检查是否有股票项
    items = page.locator('#auctionPage1 .auction-item, #auctionPage1 .auction-stock-card')
    print('stock items count:', items.count())

    # 尝试点击标题栏展开
    header.click()
    page.wait_for_timeout(500)
    page.screenshot(path='/tmp/auction_after_click.png', full_page=True)
    print('after click class:', board.get_attribute('class') if board.count() > 0 else 'N/A')
    print('after click swipe display:', swipe.evaluate('el => getComputedStyle(el).display') if swipe.count() > 0 else 'N/A')

    # 收集控制台日志
    logs = page.evaluate('() => { try { return window._auctionLogs || []; } catch(e) { return []; } }')
    print('console-like logs:', json.dumps(logs[:20], ensure_ascii=False))

    browser.close()
