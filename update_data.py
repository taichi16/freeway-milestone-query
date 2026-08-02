#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
國道百公尺里程資料自動更新與合併腳本 (update_data.py)
功能：
1. 爬取 data.gov.tw/dataset/95016，獲取動態 md5_url 及高公局的原始 ZIP 與 CSV 下載連結。
2. 比對本地 metadata.json，若線上版本有變更，則進行一鍵更新。
3. 下載 KML ZIP 檔並在記憶體中解壓縮。
4. 解析所有 KML 檔案（以 CP950 解碼檔名），使用正則表達式提取里程點（緯度、經度、海拔、路名、公告里程、方向）。
5. 下載新線段的 CSV 檔（國二甲與國4延伸段），解析 HTML Table 資料。
6. 將所有資料合併為單一輕量、精簡的 CSV 檔案：data/freeway_milestones.csv (約 539KB)。
7. 更新 metadata.json，提供本地瀏覽器快取比對。
"""

import os
import re
import ssl
import json
import csv
import zipfile
import io
import urllib.request
from datetime import datetime
from urllib.parse import quote, unquote, urlparse, urlunparse

def safe_quote_url(url):
    """安全地對 URL 中的中文路徑進行編碼，保留 scheme/netloc 與斜線"""
    p = urlparse(url)
    quoted_path = quote(unquote(p.path), safe='/')
    return urlunparse((p.scheme, p.netloc, quoted_path, p.params, p.query, p.fragment))


# 停用 SSL 憑證驗證
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

DATASET_URL = "https://data.gov.tw/dataset/95016"
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
}

def get_online_dataset_info():
    """解析政府開放資料集網頁，動態取得下載連結與 md5"""
    try:
        req = urllib.request.Request(DATASET_URL, headers=HEADERS)
        with urllib.request.urlopen(req, context=ctx) as response:
            html = response.read().decode('utf-8')
            
        # 1. 尋找所有 nid=95016 且含 md5_url 的品質下載連結
        md5_matches = re.findall(r'nid=95016&md5_url=([a-f0-9]+)', html)
        md5_list = sorted(list(set(md5_matches)))
        
        # 2. 尋找高公局原始下載連結 (.zip 或 .csv)
        # 例如：https://www.freeway.gov.tw/.../整樁及百公尺里程樁KML(schema加入).zip
        freeway_urls = re.findall(r'https?://[^\s"\'<>\\}]+freeway\.gov\.tw[^\s"\'<>\\}]*(?:\.zip|\.csv)', html)
        # 清理並還原轉義字元
        clean_urls = []
        for url in set(freeway_urls):
            cleaned = url.replace('\\u002F', '/').replace('&amp;', '&')
            if cleaned not in clean_urls:
                clean_urls.append(cleaned)
                
        # 分類下載連結
        zip_url = None
        csv_urls = []
        
        for url in clean_urls:
            if url.lower().endswith('.zip'):
                zip_url = url
            elif url.lower().endswith('.csv'):
                csv_urls.append(url)
                
        return md5_list, zip_url, csv_urls
    except Exception as e:
        print(f"解析資料集網頁錯誤: {e}")
        return [], None, []

def parse_kml_content(kml_text):
    """使用高效的正則解析 KML 檔案中的 Placemark 節點"""
    records = []
    # 尋找所有 Placemark 區塊
    placemarks = re.findall(r'<Placemark>.*?</Placemark>', kml_text, re.DOTALL)
    
    for p in placemarks:
        # 1. 提取經緯度座標
        # <coordinates>121.7357847,25.12289475,51.04</coordinates>
        coord_match = re.search(r'<coordinates>\s*([0-9.]+),([0-9.]+),([0-9.-]+)\s*</coordinates>', p)
        if not coord_match:
            coord_match = re.search(r'<coordinates>\s*([0-9.]+),([0-9.]+)\s*</coordinates>', p)
            
        if coord_match:
            lon = float(coord_match.group(1))
            lat = float(coord_match.group(2))
            elev = float(coord_match.group(3)) if len(coord_match.groups()) > 2 else 0.0
        else:
            continue
            
        # 2. 提取表格屬性 (TD 標記)
        # 第一個 TD 是 RoadName (如 國1)，第二個是 LR (方向)，第六個是 KM (公尺)，第七個是 KM2 (樁號字串)
        td_values = re.findall(r'<TD>([^<]*)</TD>', p, re.IGNORECASE)
        if len(td_values) >= 7:
            road = td_values[0].strip()
            direction = td_values[1].strip()
            km_str = td_values[5].strip()
            km_val = int(km_str) if km_str.isdigit() else 0
            milestone = td_values[6].strip()
            
            records.append({
                'road': road,
                'direction': direction,
                'km': km_val,
                'milestone': milestone,
                'lat': lat,
                'lng': lon,
                'elevation': elev
            })
            
    return records

def download_and_parse_data(zip_url, csv_urls):
    """下載原始資料並解析合併"""
    all_records = []
    
    # 1. 下載並解析 KML ZIP
    if zip_url:
        print(f"正在下載國道主線 KML ZIP...")
        # 處理 URL 編碼
        safe_zip_url = safe_quote_url(zip_url)
        
        try:
            req = urllib.request.Request(safe_zip_url, headers=HEADERS)
            with urllib.request.urlopen(req, context=ctx) as response:
                zip_data = response.read()
                
            print(f"KML ZIP 下載完成 (大小: {len(zip_data)} bytes)，開始解壓並解析...")
            
            with zipfile.ZipFile(io.BytesIO(zip_data)) as z:
                for name in z.namelist():
                    try:
                        decoded_name = name.encode('cp437').decode('cp950')
                    except Exception:
                        decoded_name = name
                        
                    if decoded_name.endswith('.kml'):
                        kml_text = z.read(name).decode('utf-8', errors='ignore')
                        records = parse_kml_content(kml_text)
                        print(f" - 解析 {decoded_name.split('/')[-1]} 獲取 {len(records)} 筆里程點")
                        all_records.extend(records)
        except Exception as e:
            print(f"下載/解析 KML ZIP 失敗: {e}")
            
    # 2. 下載並解析額外線段 CSV
    for csv_url in csv_urls:
        filename = unquote(csv_url.split('/')[-1])
        print(f"正在下載額外線段 CSV ({filename})...")
        
        # 處理 URL 中文編碼
        safe_csv_url = safe_quote_url(csv_url)
        
        try:
            req = urllib.request.Request(safe_csv_url, headers=HEADERS)
            with urllib.request.urlopen(req, context=ctx) as response:
                csv_data = response.read().decode('utf-8', errors='ignore')
                
            reader = csv.reader(csv_data.splitlines())
            next(reader, None) # 略過標頭 (緯度, 經度, 百公尺里程樁位置)
            
            csv_count = 0
            for row in reader:
                if len(row) >= 3:
                    lat_val = float(row[0].strip())
                    lng_val = float(row[1].strip())
                    table_html = row[2]
                    
                    # 提取 HTML 中的 TD
                    td_values = re.findall(r'<TD>([^<]*)</TD>', table_html, re.IGNORECASE)
                    if len(td_values) >= 7:
                        road = td_values[0].strip()
                        direction = td_values[1].strip()
                        km_str = td_values[5].strip()
                        km_val = int(km_str) if km_str.isdigit() else 0
                        milestone = td_values[6].strip()
                        elev = float(td_values[4].strip()) if td_values[4].strip() else 0.0
                        
                        all_records.append({
                            'road': road,
                            'direction': direction,
                            'km': km_val,
                            'milestone': milestone,
                            'lat': lat_val,
                            'lng': lng_val,
                            'elevation': elev
                        })
                        csv_count += 1
            print(f" - 解析 {filename} 獲取 {csv_count} 筆里程點")
        except Exception as e:
            print(f"下載/解析 CSV {filename} 失敗: {e}")
            
    return all_records

def main():
    os.makedirs("data", exist_ok=True)
    metadata_path = "metadata.json"
    output_csv_path = "data/freeway_milestones.csv"
    
    # 讀取本地 metadata
    local_metadata = {}
    if os.path.exists(metadata_path):
        try:
            with open(metadata_path, 'r', encoding='utf-8') as f:
                local_metadata = json.load(f)
        except Exception:
            pass
            
    local_md5s = local_metadata.get("resources_md5", [])
    
    print("正在檢查高速公路里程樁資料集 (dataset 95016)...")
    online_md5s, zip_url, csv_urls = get_online_dataset_info()
    
    if not online_md5s:
        print("無法取得線上資料集資訊，終止更新。")
        return
        
    print(f"本地快取 md5s: {local_md5s}")
    print(f"線上最新 md5s: {online_md5s}")
    
    # 比對版本：若本地無快取檔案，或線上 md5 列表與本地不同，則更新
    if not os.path.exists(output_csv_path) or local_md5s != online_md5s:
        print("偵測到新版本或本地資料遺失，開始執行資料重構程序...")
        
        merged_records = download_and_parse_data(zip_url, csv_urls)
        
        if not merged_records:
            print("資料重構結果為空，取消寫入。")
            return
            
        print(f"解析完成！總計獲得 {len(merged_records)} 筆里程座標資料。")
        
        # 寫入統一的 CSV 檔案
        with open(output_csv_path, 'w', encoding='utf-8', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=['road', 'direction', 'km', 'milestone', 'lat', 'lng', 'elevation'])
            writer.writeheader()
            writer.writerows(merged_records)
            
        csv_size = os.path.getsize(output_csv_path)
        print(f"資料成功寫入 {output_csv_path} (大小: {csv_size} bytes)")
        
        # 更新 metadata
        new_metadata = {
            "last_updated": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "resources_md5": online_md5s,
            "csv_size": csv_size,
            "total_records": len(merged_records),
            "last_checked": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "status": "success",
            "zip_url": zip_url,
            "csv_urls": csv_urls
        }
        
        with open(metadata_path, 'w', encoding='utf-8') as f:
            json.dump(new_metadata, f, ensure_ascii=False, indent=2)
            
        print("metadata.json 更新成功！")
    else:
        print("資料已是最新版，無須下載新資料。")
        
        # 僅更新檢查時間
        local_metadata["last_checked"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(metadata_path, 'w', encoding='utf-8') as f:
            json.dump(local_metadata, f, ensure_ascii=False, indent=2)
        print("已更新 metadata.json 中的檢查時間。")

if __name__ == "__main__":
    main()
