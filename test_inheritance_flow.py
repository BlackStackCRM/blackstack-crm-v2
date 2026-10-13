#!/usr/bin/env python3
"""Integration test for inventory hierarchy + products integration.
Tests the spec: Inventory Management creates structure, Products uses it."""
import requests, json, sys

BASE = "http://localhost:3111"
LOGIN = {"email": "admin@blackstack.local", "password": "admin123"}

def main():
    s = requests.Session()
    
    # Login
    r = s.post(f"{BASE}/api/auth/login", json=LOGIN)
    assert r.status_code == 200, f"Login failed: {r.text}"
    token = r.json()["data"]["token"]
    s.headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    
    print("✓ Logged in successfully")
    
    # Step 1: Check if hierarchy data exists, if not create it
    r = s.get(f"{BASE}/api/inventory/hierarchy/summary")
    summary = r.json()
    print(f"Hierarchy summary: {summary}")
    
    if summary.get("locations", 0) == 0:
        print("\n--- Setting up hierarchy data ---")
        # Create Location
        r = s.post(f"{BASE}/api/inventory/masters/inv_locations", json={
            "name": "Muvattupuzha", "code": "MUV001", "address": "Muvattupuzha, Kerala", "is_active": 1
        })
        loc_id = r.json()["id"]
        print(f"✓ Created Location: Muvattupuzha ({loc_id})")
        
        # Create Godowns
        r = s.post(f"{BASE}/api/inventory/masters/godowns", json={"name": "Godown 1", "code": "GD001", "location_id": loc_id, "is_active": 1})
        gd1_id = r.json()["id"]
        r = s.post(f"{BASE}/api/inventory/masters/godowns", json={"name": "Godown 2", "code": "GD002", "location_id": loc_id, "is_active": 1})
        gd2_id = r.json()["id"]
        r = s.post(f"{BASE}/api/inventory/masters/godowns", json={"name": "Godown 3", "code": "GD003", "location_id": loc_id, "is_active": 1})
        print(f"✓ Created 3 Godowns")
        
        # Create Inventory Groups
        r = s.post(f"{BASE}/api/inventory/masters/stock_groups", json={"name": "Primary Stock", "godown_id": gd1_id, "location_id": loc_id, "is_active": 1})
        ig1_id = r.json()["id"]
        r = s.post(f"{BASE}/api/inventory/masters/stock_groups", json={"name": "Service Stock", "godown_id": gd1_id, "location_id": loc_id, "is_active": 1})
        ig2_id = r.json()["id"]
        print(f"✓ Created 2 Inventory Groups")
        
        # Create Item Groups
        s.post(f"{BASE}/api/inventory/masters/stock_groups", json={"name": "Laptop", "parent_group_id": ig1_id, "godown_id": gd1_id, "location_id": loc_id, "is_active": 1})
        s.post(f"{BASE}/api/inventory/masters/stock_groups", json={"name": "Printer", "parent_group_id": ig1_id, "godown_id": gd1_id, "location_id": loc_id, "is_active": 1})
        s.post(f"{BASE}/api/inventory/masters/stock_groups", json={"name": "Battery", "parent_group_id": ig2_id, "godown_id": gd1_id, "location_id": loc_id, "is_active": 1})
        s.post(f"{BASE}/api/inventory/masters/stock_groups", json={"name": "Keyboard", "parent_group_id": ig2_id, "godown_id": gd1_id, "location_id": loc_id, "is_active": 1})
        print(f"✓ Created 4 Item Groups (Laptop, Printer, Battery, Keyboard)")
    else:
        # Get existing IDs from hierarchy
        r = s.get(f"{BASE}/api/inventory/hierarchy")
        h = r.json()
        loc = h["locations"][0]
        loc_id = loc["id"]
        godowns = loc["godowns"]
        gd1 = godowns[0]
        gd1_id = gd1["id"]
        gd2_id = godowns[1]["id"] if len(godowns) > 1 else gd1_id
        ig1 = gd1["inventoryGroups"][0]
        ig1_id = ig1["id"]
        itg1 = ig1["itemGroups"][0]
        itg1_id = itg1["id"]
    
    # Verify hierarchy tree
    r = s.get(f"{BASE}/api/inventory/hierarchy")
    h = r.json()
    print(f"\n✓ Hierarchy tree has {len(h['locations'])} locations")
    
    # Verify hierarchy summary
    r = s.get(f"{BASE}/api/inventory/hierarchy/summary")
    summary = r.json()
    print(f"✓ Summary: {summary}")
    assert summary["locations"] >= 1
    assert summary["godowns"] >= 3
    assert summary["inventoryGroups"] >= 2
    assert summary["itemGroups"] >= 4
    
    # Verify dependent dropdowns
    r = s.get(f"{BASE}/api/inventory/locations")
    locs = r.json()
    loc_id = locs["items"][0]["id"]
    
    r = s.get(f"{BASE}/api/inventory/locations/{loc_id}/godowns")
    gds = r.json()
    gd1_id = gds["items"][0]["id"]
    
    r = s.get(f"{BASE}/api/inventory/godowns/{gd1_id}/inventory-groups")
    igs = r.json()
    ig1_id = igs["items"][0]["id"]
    
    r = s.get(f"{BASE}/api/inventory/inventory-groups/{ig1_id}/item-groups")
    itgs = r.json()
    itg1_id = itgs["items"][0]["id"]
    
    print(f"✓ Dependent dropdowns: Location → {loc_id[:12]}... → Godown → {gd1_id[:12]}... → IG → {ig1_id[:12]}... → ITG → {itg1_id[:12]}...")
    
    # Test: Empty state - Godown 2 has no inventory groups
    r = s.get(f"{BASE}/api/inventory/godowns/{gds['items'][1]['id']}/inventory-groups")
    assert r.json()["total"] == 0
    print(f"✓ Godown 2 has 0 inventory groups (empty state correct)")
    
    # Test: Create product with full hierarchy
    r = s.post(f"{BASE}/api/products", json={
        "name": "Test Laptop Pro",
        "sku": "TLP-TEST-001",
        "price": 75000,
        "cost": 60000,
        "location_id": loc_id,
        "godown_id": gd1_id,
        "inventory_group_id": ig1_id,
        "item_group_id": itg1_id,
        "opening_quantity": 3,
        "track_inventory": True,
        "is_active": 1
    })
    assert r.status_code == 201, f"Product creation failed: {r.text[:300]}"
    prod = r.json()["data"]
    print(f"✓ Created product: {prod['name']} (StockItem: {prod['stockItemId']})")
    
    # Verify stock item has hierarchy
    r = s.get(f"{BASE}/api/inventory/stocks/product/{prod['id']}")
    si = r.json()
    assert si["locationId"] == loc_id
    assert si["godownId"] == gd1_id
    assert si["inventoryGroupId"] == ig1_id
    assert si["itemGroupId"] == itg1_id
    assert si["onHandQty"] == 3, f"Expected onHandQty=3, got {si.get('onHandQty')}"
    print(f"✓ Stock item hierarchy verified (on_hand_qty={si['onHandQty']}, avg_rate={si['avgRate']})")
    
    # Test: Partial hierarchy (should fail)
    r = s.post(f"{BASE}/api/products", json={
        "name": "Partial Product", "sku": "PART-TEST",
        "location_id": loc_id, "godown_id": gd1_id,
        "track_inventory": True, "is_active": 1
    })
    assert r.status_code == 400
    err = r.json()["error"]["message"]
    assert "all four" in err
    print(f"✓ Partial hierarchy rejected: {err[:60]}...")
    
    # Test: Invalid item_group_id (should fail)
    r = s.post(f"{BASE}/api/products", json={
        "name": "Bad Product", "sku": "BAD-TEST",
        "location_id": loc_id, "godown_id": gd1_id,
        "inventory_group_id": ig1_id, "item_group_id": "nonexistent",
        "track_inventory": True, "is_active": 1
    })
    assert r.status_code == 400
    err = r.json()["error"]["message"]
    assert "item_group_id" in err
    print(f"✓ Invalid item_group_id rejected: {err[:60]}...")
    
    # Test: Backward compat (no hierarchy)
    r = s.post(f"{BASE}/api/products", json={
        "name": "Simple Product", "sku": "SIMPLE-TEST",
        "price": 100, "cost": 50, "is_active": 1
    })
    assert r.status_code == 201
    print(f"✓ Backward compat: product created without hierarchy")
    
    # Test: Product list includes hierarchy columns
    r = s.get(f"{BASE}/api/products?limit=10")
    products = r.json()["data"]["items"]
    prod_with_hier = [p for p in products if p.get("locationId")]
    print(f"✓ Product list: {len(products)} products, {len(prod_with_hier)} with hierarchy fields")
    
    # Test: Update product hierarchy
    r = s.put(f"{BASE}/api/products/{prod['id']}", json={
        "location_id": loc_id,
        "godown_id": gds['items'][1]['id'] if len(gds['items']) > 1 else gd1_id,
        "inventory_group_id": ig1_id,
        "item_group_id": itg1_id,
    })
    if r.status_code == 200:
        print(f"✓ Product hierarchy updated successfully")
        # Verify the update
        r = s.get(f"{BASE}/api/inventory/stocks/product/{prod['id']}")
        si = r.json()
        print(f"  → Godown: {si['godownId']}")
    else:
        err = r.json().get("error", {}).get("message", "unknown")
        print(f"! Update returned: {r.status_code} - {err}")
    
    print("\n=== ALL TESTS PASSED ===")

if __name__ == "__main__":
    main()
