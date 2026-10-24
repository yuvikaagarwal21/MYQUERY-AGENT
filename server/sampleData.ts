export interface RawCsvFileInput {
  fileName: string;
  csvContent: string;
}

export const DEFAULT_CUSTOMERS_CSV = `Customer ID,Company Name,Segment,Region,Signup Date
CUST-101,Apex Logistics,Enterprise,North America,2023-01-15
 CUST-102 ,Beacon Health,Enterprise,North America,2023-02-20
CUST-103,Cobalt Retail,Mid-Market,Europe,2023-03-11
CUST-104,Delta FinTech,SMB,Asia-Pacific,2023-04-05
CUST-105,Echo Manufacturing,Enterprise,Europe,2023/15/99
CUST-106,Frontier Solar,Mid-Market,N/A,2023-06-18
CUST-107,Granite Media,SMB,North America,2023-07-22
CUST-108,Harbor BioLabs,Enterprise,Asia-Pacific,UNKNOWN
 CUST-109,Ionic Cloud,Mid-Market,Europe,2023-09-14
CUST-110,Juniper Foods,SMB,UNKNOWN,2023-10-30`;

export const DEFAULT_ORDERS_CSV = `Order ID,Customer ID,Product Category,Order Amount ($),Discount (%),Order Date,Status
ORD-5001,CUST-101,Cloud Compute,"$4,200.00",10%,2024-01-10,Completed
ORD-5002, CUST-102 ,Security Suite,"$3,150.50",5%,2024-01-18, Completed 
ORD-5003,CUST-103,Analytics Pro,"$1,800.00",0%,2024-01-25,completed
ORD-5004,CUST-104,Data Pipeline,950.25,0%, 2024-02-04 ,Completed
ORD-5005,CUST-105,Cloud Compute,"$5,600.00",15%,2024-02-14,Completed
ORD-5006,CUST-101,Analytics Pro,UNKNOWN,N/A,2024-02-19,Pending
ORD-5007,CUST-106,Security Suite,"$2,250.00",5%,2024-02-27,Completed
ORD-5008,CUST-107,Data Pipeline,ERROR,0%,2024-03-03,Cancelled
ORD-5009,CUST-108,Cloud Compute," $6,400.75 ",12%,2024-03-11,Completed
ORD-5010,CUST-109,Analytics Pro,"$2,100.00",5%,2024-03-19,Completed
ORD-5011,CUST-110,Data Pipeline,N/A,ERROR,2024/13/45,Pending
ORD-5012,CUST-102,Cloud Compute,"$3,850.00",10%,2024-03-28,Completed
ORD-5013,CUST-103,Security Suite,"$1,450.00",0%,2024-04-06,Cancelled
ORD-5014,CUST-105,Analytics Pro,"$2,900.50",8%,2024-04-15,Completed
ORD-5015,CUST-108,Security Suite,NULL,N/A,TBD,UNKNOWN
ORD-5016,CUST-101,Data Pipeline,"$1,750.00",5%,2024-04-22,Completed
ORD-5017,CUST-104,Analytics Pro,620.00,0%,2024-05-02,Pending
ORD-5018,CUST-106,Cloud Compute,"$4,500.00",10%,2024-05-14,Completed
ORD-5019,CUST-109,Security Suite," $1,980.00 ",5%,2024-05-21,Completed
ORD-5020,CUST-107,Cloud Compute,,0%,2024-05-29,Cancelled`;

export const EXTRA_SHIPMENTS_CSV = `Shipment ID,Order ID,Carrier,Shipping Cost ($),Delivery Days,Ship Date
SHP-901,ORD-5001,FedEx Priority,"$120.50",2,2024-01-11
SHP-902, ORD-5002 ,DHL Express,"$95.00",3,2024-01-19
SHP-903,ORD-5003,UPS Ground,45.00,5,2024-01-26
SHP-904,ORD-5005,DHL Express,"$180.00",4,2024-02-15
SHP-905,ORD-5007,FedEx Priority,UNKNOWN,N/A,2024-02-28
SHP-906,ORD-5009,DHL Express," $210.25 ",3,2024-03-12
SHP-907,ORD-5010,UPS Ground,ERROR,-1,invalid-date
SHP-908,ORD-5012,FedEx Priority,"$115.00",2,2024-03-29`;

export function getDefaultDatasetFiles(): RawCsvFileInput[] {
  return [
    { fileName: 'customers.csv', csvContent: DEFAULT_CUSTOMERS_CSV },
    { fileName: 'orders.csv', csvContent: DEFAULT_ORDERS_CSV },
  ];
}
