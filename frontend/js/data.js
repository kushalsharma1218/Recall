// ============================================================
// data.js — Azure DB Ticket Corpus & Patch Library
// Seeded data cleared — the model learns from your real ADO tickets.
// Train patches and tickets are stored in localStorage via TrainingStore.
// ============================================================

const PATCH_LIBRARY = [];  // Populated at runtime by TrainingStore

const HISTORICAL_TICKETS = []; // Empty — model learns from trained ADO data only

// Severity configs
const SEVERITY_CONFIG = {
  critical: { label: "Critical", color: "#ff4757", priority: 4, slaHours: 4 },
  high: { label: "High", color: "#ff6b35", priority: 3, slaHours: 8 },
  medium: { label: "Medium", color: "#ffd32a", priority: 2, slaHours: 24 },
  low: { label: "Low", color: "#2ed573", priority: 1, slaHours: 72 }
};

const DB_SYSTEMS = [
  "SQL Server 2019",
  "SQL Server 2022",
  "Azure SQL Database",
  "Azure SQL Managed Instance",
  "Azure SQL Serverless",
  "Azure SQL Elastic Pool",
  "SQL Server on Azure VM",
  "SQL Server 2019 Always On",
  "Azure Database for PostgreSQL",
  "Azure Database for MySQL",
  "Azure Cosmos DB",
  "Azure Database for MariaDB"
];
