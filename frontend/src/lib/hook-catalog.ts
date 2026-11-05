import type { HookShell, Locale } from '@/types'

/**
 * What a hook can read. Scripts that call Data Control Tower are written by the hook wizard and
 * its snippets, in hook-builder.ts.
 *
 * The context variables are the ones Delphix documents for its hook operations — set by the
 * engine on the host where the hook runs, which depends on the data source (Oracle and SQL Server
 * document theirs; AppData and DB2 hooks get the data directory). Credential variables come from
 * the hook template itself: each base name configured there becomes <BASE>_USER, <BASE>_PASSWORD,
 * <BASE>_PUBKEY and <BASE>_PRIVKEY, set only when the credential has that part.
 */

type Text = Record<Locale, string>

export interface ContextVariable {
  name: string
  /** Where Delphix sets it. */
  scope: 'oracle' | 'oracleVdb' | 'sqlserver' | 'appdata' | 'credential'
  text: Text
}

export const CONTEXT_VARIABLES: ContextVariable[] = [
  { name: 'ORACLE_SID', scope: 'oracle', text: { en: 'Oracle system identifier of the dSource or VDB.', 'pt-BR': 'Identificador de sistema Oracle do dSource ou da VDB.', es: 'Identificador de sistema Oracle del dSource o de la VDB.' } },
  { name: 'ORACLE_BASE', scope: 'oracle', text: { en: 'Base directory of the Oracle software.', 'pt-BR': 'Diretório base do software Oracle.', es: 'Directorio base del software Oracle.' } },
  { name: 'ORACLE_HOME', scope: 'oracle', text: { en: 'Oracle home; its bin is on PATH and its lib on LD_LIBRARY_PATH.', 'pt-BR': 'Oracle home; o bin dele está no PATH e o lib no LD_LIBRARY_PATH.', es: 'Oracle home; su bin está en el PATH y su lib en LD_LIBRARY_PATH.' } },
  { name: 'CRS_HOME', scope: 'oracle', text: { en: 'Cluster services home — RAC only.', 'pt-BR': 'Home dos serviços de cluster — só em RAC.', es: 'Home de los servicios de clúster — solo en RAC.' } },
  { name: 'ORAENV_ASK', scope: 'oracle', text: { en: 'Always NO.', 'pt-BR': 'Sempre NO.', es: 'Siempre NO.' } },
  { name: 'DELPHIX_DATABASE_NAME', scope: 'oracle', text: { en: 'Database name as Oracle reports it.', 'pt-BR': 'Nome do banco como o Oracle o informa.', es: 'Nombre de la base como lo informa Oracle.' } },
  { name: 'DELPHIX_DATABASE_UNIQUE_NAME', scope: 'oracle', text: { en: 'Database unique name as Oracle reports it.', 'pt-BR': 'Nome único do banco como o Oracle o informa.', es: 'Nombre único de la base como lo informa Oracle.' } },
  { name: 'DELPHIX_PDB_NAME', scope: 'oracle', text: { en: 'PDB name — pluggable databases only.', 'pt-BR': 'Nome da PDB — só em pluggable databases.', es: 'Nombre de la PDB — solo en pluggable databases.' } },
  { name: 'DELPHIX_MOUNT_PATH', scope: 'oracleVdb', text: { en: 'Root of the NFS mount holding the VDB data.', 'pt-BR': 'Raiz do mount NFS com os dados da VDB.', es: 'Raíz del montaje NFS con los datos de la VDB.' } },
  { name: 'MASKING_CONNECTOR_HOST', scope: 'oracleVdb', text: { en: 'Host the masking connector uses — masked provisioning only.', 'pt-BR': 'Host que o conector de mascaramento usa — só no provisionamento mascarado.', es: 'Host que usa el conector de enmascaramiento — solo en el aprovisionamiento enmascarado.' } },
  { name: 'MASKING_CONNECTOR_PORT', scope: 'oracleVdb', text: { en: 'Port the masking connector uses — masked provisioning only.', 'pt-BR': 'Porta que o conector de mascaramento usa — só no provisionamento mascarado.', es: 'Puerto que usa el conector de enmascaramiento — solo en el aprovisionamiento enmascarado.' } },
  { name: 'VDB_DATABASE_NAME', scope: 'sqlserver', text: { en: 'The VDB\'s database (Delphix documents it both as the VDB name and as the SQL Server database name — check on your engine).', 'pt-BR': 'O banco da VDB (a Delphix o documenta como nome da VDB e como nome do banco SQL Server — confira no seu engine).', es: 'La base de la VDB (Delphix la documenta como nombre de la VDB y como nombre de la base SQL Server — compruébalo en tu engine).' } },
  { name: 'VDB_INSTANCE_NAME', scope: 'sqlserver', text: { en: 'SQL Server instance name.', 'pt-BR': 'Nome da instância SQL Server.', es: 'Nombre de la instancia SQL Server.' } },
  { name: 'VDB_INSTANCE_HOST', scope: 'sqlserver', text: { en: 'Windows host running the instance.', 'pt-BR': 'Host Windows que roda a instância.', es: 'Host Windows que ejecuta la instancia.' } },
  { name: 'VDB_INSTANCE_PORT', scope: 'sqlserver', text: { en: 'SQL Server instance port.', 'pt-BR': 'Porta da instância SQL Server.', es: 'Puerto de la instancia SQL Server.' } },
  { name: 'DLPX_DATA_DIRECTORY', scope: 'appdata', text: { en: 'Where the dataset is mounted: the VDB, or the staging copy for a dSource (AppData, unstructured files, DB2).', 'pt-BR': 'Onde o dataset está montado: a VDB, ou a cópia de staging de um dSource (AppData, arquivos, DB2).', es: 'Dónde está montado el dataset: la VDB, o la copia de staging de un dSource (AppData, archivos, DB2).' } },
  { name: '<BASE>_USER', scope: 'credential', text: { en: 'User of a credential configured on the hook template.', 'pt-BR': 'Usuário de uma credencial configurada no hook template.', es: 'Usuario de una credencial configurada en el hook template.' } },
  { name: '<BASE>_PASSWORD', scope: 'credential', text: { en: 'Password (or key) of that credential.', 'pt-BR': 'Senha (ou chave) dessa credencial.', es: 'Contraseña (o clave) de esa credencial.' } },
  { name: '<BASE>_PUBKEY', scope: 'credential', text: { en: 'Public key, for an SSH-key credential.', 'pt-BR': 'Chave pública, numa credencial de chave SSH.', es: 'Clave pública, en una credencial de clave SSH.' } },
  { name: '<BASE>_PRIVKEY', scope: 'credential', text: { en: 'Private key, for an SSH-key credential.', 'pt-BR': 'Chave privada, numa credencial de chave SSH.', es: 'Clave privada, en una credencial de clave SSH.' } },
]

/** Where a hook can be attached, as Delphix lists its hook operations. */
export const HOOK_POINTS = {
  dsource: ['Pre-sync', 'Post-sync'],
  vdb: ['Configure clone', 'Pre-refresh', 'Post-refresh', 'Pre-rollback', 'Post-rollback', 'Pre-snapshot', 'Post-snapshot', 'Pre-start', 'Post-start', 'Pre-stop', 'Post-stop'],
}

/** How a script reads a variable, for the insert buttons. */
export const variableSyntax = (shell: HookShell, name: string) =>
  shell === 'ps' || shell === 'psd' ? `$env:${name}` : shell === 'expect' ? `$env(${name})` : `"$${name}"`
