import type {Metadata} from "next";
import {InventoryManager} from "@/components/inventory-manager";
export const metadata:Metadata={title:'Inventory',robots:{index:false,follow:false}};
export default function AdminPage(){return <InventoryManager/>;}
