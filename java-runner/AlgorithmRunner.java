import com.delphix.masking.api.plugin.*;
import com.delphix.masking.api.plugin.exception.*;
import com.delphix.masking.api.plugin.referenceType.*;
import com.delphix.masking.api.plugin.typeAdapters.*;
import com.delphix.masking.api.plugin.utils.*;
import com.delphix.masking.api.provider.*;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import org.codehaus.janino.ExpressionEvaluator;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.util.*;
import java.util.logging.*;

public class AlgorithmRunner {

    // Plugin JAR path — resolved at startup from system property or default location
    static String PLUGIN_JAR_PATH = System.getProperty("plugin.jar",
        "../lib/delphix-algorithm-plugin-2026.3.0-SNAPSHOT.jar");

    // Built-in component catalog: name → uninitialized component (lazy setup)
    static Map<String, MaskingComponent> BUILTIN_CATALOG = null;

    static final LinkedHashMap<String, String> ALGORITHMS = new LinkedHashMap<>();
    static {
        ALGORITHMS.put("algorithm.plugin.redact.Redact", "Redact");
        ALGORITHMS.put("algorithm.plugin.repeatFirstDigit.RepeatFirstDigit", "Repeat First Digit");
        ALGORITHMS.put("algorithm.plugin.freeTextRedaction.FreeTextRedaction", "Free Text Redaction");
        ALGORITHMS.put("algorithm.plugin.minMax.MinMaxBigDecimal", "Min/Max BigDecimal");
        ALGORITHMS.put("algorithm.plugin.minMax.MinMaxLocalDateTime", "Min/Max Date/Time");
        ALGORITHMS.put("algorithm.plugin.expression.NumericExpression", "Numeric Expression");
        ALGORITHMS.put("algorithm.plugin.characterReplacement.CharacterReplacement", "Character Replacement");
        ALGORITHMS.put("algorithm.plugin.characterMapping.CharacterMapping", "Character Mapping");
        ALGORITHMS.put("algorithm.plugin.characterMapping.NumericMapping", "Numeric Mapping");
        ALGORITHMS.put("algorithm.plugin.characterMapping.PaymentCard", "Payment Card");
        ALGORITHMS.put("algorithm.plugin.email.Email", "Email");
        ALGORITHMS.put("algorithm.plugin.phone.Phone", "Phone");
        ALGORITHMS.put("algorithm.plugin.name.Name", "Name");
        ALGORITHMS.put("algorithm.plugin.name.FullName", "Full Name");
        ALGORITHMS.put("algorithm.plugin.financialId.FinancialIdBr", "Financial ID BR (CPF/CNPJ)");
        ALGORITHMS.put("algorithm.plugin.iban.IBAN", "IBAN");
        ALGORITHMS.put("algorithm.plugin.checkdigit.Checkdigit", "Check Digit");
        ALGORITHMS.put("algorithm.plugin.segmentMapping.SegmentMapping", "Segment Mapping");
        ALGORITHMS.put("algorithm.plugin.decompose.RegexDecompose", "Regex Decompose");
        ALGORITHMS.put("algorithm.plugin.secureLookup.SecureLookup", "Secure Lookup");
        ALGORITHMS.put("algorithm.plugin.nullSecureLookup.NullSecureLookup", "Null-Safe Secure Lookup");
        ALGORITHMS.put("algorithm.plugin.mapping.Mapping", "Mapping");
        ALGORITHMS.put("algorithm.plugin.tokenization.Tokenization", "Tokenization");
        ALGORITHMS.put("algorithm.plugin.shuffle.Shuffle", "Shuffle");
        ALGORITHMS.put("algorithm.plugin.stringAlgorithmChain.StringAlgorithmChain", "String Algorithm Chain");
        ALGORITHMS.put("algorithm.plugin.dataCleansing.DataCleansing", "Data Cleansing");
        ALGORITHMS.put("algorithm.plugin.dateAlgorithms.DateShift", "Date Shift");
        ALGORITHMS.put("algorithm.plugin.dateAlgorithms.DateShiftDiscrete", "Date Shift Discrete");
        ALGORITHMS.put("algorithm.plugin.dateAlgorithms.DateReplacement", "Date Replacement");
        ALGORITHMS.put("algorithm.plugin.address.MultiColumnAddress", "Multi-Column Address");
        ALGORITHMS.put("algorithm.plugin.conditional.MultiColumnCondition", "Multi-Column Condition");
    }

    public static void main(String[] args) {
        // Suppress Java logging noise
        Logger.getLogger("").setLevel(Level.OFF);

        // Force UTF-8 on stdout so accented characters are not corrupted
        PrintStream out;
        try {
            out = new PrintStream(System.out, true, "UTF-8");
        } catch (UnsupportedEncodingException e) {
            out = System.out;
        }

        ObjectMapper mapper = new ObjectMapper();
        try {
            JsonNode req = mapper.readTree(new InputStreamReader(System.in, StandardCharsets.UTF_8));
            String command = req.get("command").asText();
            JsonNode result;

            switch (command) {
                case "list":              result = handleList(mapper); break;
                case "schema":            result = handleSchema(mapper, req); break;
                case "mask":              result = handleMask(mapper, req); break;
                case "mask_batch":        result = handleMaskBatch(mapper, req); break;
                case "mask_multicolumn":  result = handleMaskMultiColumn(mapper, req); break;
                default:
                    result = error(mapper, "Unknown command: " + command);
            }

            out.println(mapper.writeValueAsString(result));
        } catch (Exception e) {
            try {
                out.println(mapper.writeValueAsString(error(mapper, e.getClass().getSimpleName() + ": " + e.getMessage())));
            } catch (Exception ignored) {
                out.println("{\"error\":\"Fatal error\"}");
            }
        }
    }

    // ── Plugin pre-load ───────────────────────────────────────────────────────

    // Collects all default instances from the plugin WITHOUT calling setup (lazy).
    @SuppressWarnings("unchecked")
    static synchronized Map<String, MaskingComponent> getBuiltinCatalog() throws Exception {
        if (BUILTIN_CATALOG != null) return BUILTIN_CATALOG;

        Map<String, MaskingComponent> catalog = new HashMap<>();
        PluginLoader loader = new PluginLoader(PLUGIN_JAR_PATH, true);

        for (MaskingComponent framework : loader.discoverAlgorithms()) {
            collectInstances(framework, catalog, new java.util.HashSet<>());
        }

        BUILTIN_CATALOG = catalog;
        return catalog;
    }

    static void collectInstances(MaskingComponent comp, Map<String, MaskingComponent> catalog,
            Set<String> visited) {
        String cls = comp.getClass().getName();
        if (visited.contains(cls)) return;
        visited.add(cls);

        java.util.Collection<MaskingComponent> defaults = comp.getDefaultInstances();
        if (defaults != null) {
            for (MaskingComponent sub : defaults) {
                catalog.put(sub.getName(), sub);
                collectInstances(sub, catalog, visited);
            }
        }
    }

    // ── Commands ─────────────────────────────────────────────────────────────

    static JsonNode handleList(ObjectMapper mapper) {
        ArrayNode arr = mapper.createArrayNode();
        for (Map.Entry<String, String> e : ALGORITHMS.entrySet()) {
            ObjectNode algo = mapper.createObjectNode();
            algo.put("className", e.getKey());
            algo.put("displayName", e.getValue());
            arr.add(algo);
        }
        return arr;
    }

    static JsonNode handleSchema(ObjectMapper mapper, JsonNode req) throws Exception {
        String className = req.get("algorithm").asText();
        MaskingComponent component = instantiate(className);
        try {
            String schemaText = ComponentConfigurator.generateSchemaText(component);
            ObjectNode result = mapper.createObjectNode();
            result.set("schema", mapper.readTree(schemaText));
            return result;
        } catch (Exception e) {
            return error(mapper, "Schema error: " + e.getMessage());
        }
    }

    @SuppressWarnings("unchecked")
    static JsonNode handleMask(ObjectMapper mapper, JsonNode req) {
        try {
            String className = req.get("algorithm").asText();
            String input = req.has("input") ? req.get("input").asText() : "";
            String configJson = req.has("config") && !req.get("config").isNull()
                    ? mapper.writeValueAsString(req.get("config")) : "{}";
            String keyString = req.has("key") ? req.get("key").asText() : "delphix-default-key";
            String mode = req.has("mode") ? req.get("mode").asText() : "MASK";

            MaskingComponent component = instantiate(className);

            if (!configJson.equals("{}")) {
                // ComponentConfigurator expects "yyyy-MM-dd HH:mm:ss" for LocalDateTime fields.
                // Convert ISO 8601 "T" separator to space before applying.
                configJson = configJson.replaceAll(
                    "(\\d{4}-\\d{2}-\\d{2})T(\\d{2}:\\d{2}:\\d{2})", "$1 $2");
                ComponentConfigurator.applyConfiguration(component, configJson);
            }

            // Extra algorithms from saved tests — can be referenced by name in sub-algorithm fields
            Map<String, JsonNode> extraAlgos = new HashMap<>();
            if (req.has("additionalAlgorithms") && req.get("additionalAlgorithms").isArray()) {
                for (JsonNode extra : req.get("additionalAlgorithms")) {
                    if (extra.has("name")) extraAlgos.put(extra.get("name").asText(), extra);
                }
            }

            // Registry of already-set-up sub-algorithms (populated lazily on demand)
            Map<String, MaskingAlgorithm<?>> registry = new HashMap<>();
            ComponentService service = buildService(keyString, mapper, registry, extraAlgos);

            setupRecursive(component, service, registry);
            component.validate();

            if (!"MASK".equals(mode) && component instanceof MaskingAlgorithm) {
                MaskingAlgorithm.MaskingMode maskingMode = MaskingAlgorithm.MaskingMode.valueOf(mode);
                ((MaskingAlgorithm<?>) component).setMaskingMode(maskingMode);
            }

            String output = invokeMask(component, input);

            ObjectNode result = mapper.createObjectNode();
            result.put("output", output);
            return result;

        } catch (NonConformantDataException e) {
            return buildMaskError(mapper, "NON_CONFORMANT", e.getMessage());
        } catch (ComponentConfigurationException e) {
            return buildMaskError(mapper, "CONFIG_ERROR", e.getMessage());
        } catch (java.lang.reflect.InvocationTargetException e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            if (cause instanceof NonConformantDataException)
                return buildMaskError(mapper, "NON_CONFORMANT", cause.getMessage());
            if (cause instanceof ComponentConfigurationException)
                return buildMaskError(mapper, "CONFIG_ERROR", cause.getMessage());
            return buildMaskError(mapper, "ERROR", cause.getClass().getSimpleName() + ": " + cause.getMessage());
        } catch (Exception e) {
            return buildMaskError(mapper, "ERROR", e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }

    @SuppressWarnings("unchecked")
    static JsonNode handleMaskMultiColumn(ObjectMapper mapper, JsonNode req) {
        try {
            String className = req.get("algorithm").asText();
            String configJson = req.has("config") && !req.get("config").isNull()
                    ? mapper.writeValueAsString(req.get("config")) : "{}";
            String keyString = req.has("key") ? req.get("key").asText() : "delphix-default-key";
            JsonNode columnsNode = req.has("columns") ? req.get("columns") : mapper.createArrayNode();

            Map<String, JsonNode> extraAlgos = new HashMap<>();
            if (req.has("additionalAlgorithms") && req.get("additionalAlgorithms").isArray()) {
                for (JsonNode extra : req.get("additionalAlgorithms")) {
                    if (extra.has("name")) extraAlgos.put(extra.get("name").asText(), extra);
                }
            }

            // Build GenericDataRow from user-supplied columns
            Map<String, GenericData> rowMap = new LinkedHashMap<>();
            for (JsonNode col : columnsNode) {
                String name = col.get("name").asText();
                String value = col.has("value") && !col.get("value").isNull()
                        ? col.get("value").asText() : null;
                String type = col.has("type") ? col.get("type").asText() : "STRING";

                MaskValueMetadataImpl meta = new MaskValueMetadataImpl();
                GenericData data;

                switch (type) {
                    case "NUMERIC": {
                        meta.maskingType(MaskingAlgorithm.MaskingType.BIG_DECIMAL)
                            .storageType(UnderlyingDataType.BIG_DECIMAL)
                            .dataPathFieldName(name);
                        PassThroughAdapter adapter = new PassThroughAdapter(
                            MaskingAlgorithm.MaskingType.BIG_DECIMAL, UnderlyingDataType.BIG_DECIMAL);
                        java.math.BigDecimal bdVal = value != null ? new java.math.BigDecimal(value) : null;
                        data = GenericDataImpl.CreateGenericData(bdVal, adapter, meta, false);
                        break;
                    }
                    case "DATE": {
                        meta.maskingType(MaskingAlgorithm.MaskingType.LOCAL_DATE_TIME)
                            .storageType(UnderlyingDataType.LOCAL_DATE_TIME)
                            .dataPathFieldName(name);
                        PassThroughAdapter adapter = new PassThroughAdapter(
                            MaskingAlgorithm.MaskingType.LOCAL_DATE_TIME, UnderlyingDataType.LOCAL_DATE_TIME);
                        java.time.LocalDateTime dtVal = value != null ? parseLocalDateTime(value) : null;
                        data = GenericDataImpl.CreateGenericData(dtVal, adapter, meta, false);
                        break;
                    }
                    default: { // STRING
                        meta.maskingType(MaskingAlgorithm.MaskingType.STRING)
                            .storageType(UnderlyingDataType.STRING)
                            .dataPathFieldName(name);
                        PassThroughAdapter adapter = new PassThroughAdapter(
                            MaskingAlgorithm.MaskingType.STRING, UnderlyingDataType.STRING);
                        data = GenericDataImpl.CreateGenericData(value, adapter, meta, false);
                        break;
                    }
                }
                rowMap.put(name, data);
            }

            GenericDataRow row = GenericDataRowImpl.from(rowMap);

            // Setup and run algorithm
            MaskingComponent component = instantiate(className);
            if (!configJson.equals("{}")) {
                configJson = configJson.replaceAll(
                    "(\\d{4}-\\d{2}-\\d{2})T(\\d{2}:\\d{2}:\\d{2})", "$1 $2");
                // MultiColumnCondition has a bug: getDateAlgorithm() NPEs when date1/numeric1/binary1
                // are absent and fallbackType is null (only happens outside the engine). Work around it
                // by injecting default algo refs for any missing typed-slots in each condition.
                configJson = injectMultiColumnDefaults(mapper, configJson);
                ComponentConfigurator.applyConfiguration(component, configJson);
            }

            Map<String, MaskingAlgorithm<?>> registry = new HashMap<>();
            ComponentService service = buildService(keyString, mapper, registry, extraAlgos);
            setupRecursive(component, service, registry);
            component.validate();

            GenericDataRow resultRow = ((MaskingAlgorithm<GenericDataRow>) component).mask(row);

            // Collect results for every column
            ObjectNode result = mapper.createObjectNode();
            ObjectNode outputs = mapper.createObjectNode();
            for (JsonNode col : columnsNode) {
                String name = col.get("name").asText();
                GenericData data = resultRow.get(name);
                if (data == null) {
                    outputs.putNull(name);
                } else {
                    try {
                        Object val = data.getUnderlyingValue();
                        if (val == null) outputs.putNull(name);
                        else outputs.put(name, val.toString());
                    } catch (Exception e) {
                        outputs.put(name, "ERROR: " + e.getMessage());
                    }
                }
            }
            result.set("columns", outputs);
            return result;

        } catch (NonConformantDataException e) {
            return buildMaskError(mapper, "NON_CONFORMANT", e.getMessage());
        } catch (ComponentConfigurationException e) {
            return buildMaskError(mapper, "CONFIG_ERROR", e.getMessage());
        } catch (java.lang.reflect.InvocationTargetException e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            if (cause instanceof NonConformantDataException)
                return buildMaskError(mapper, "NON_CONFORMANT", cause.getMessage());
            if (cause instanceof ComponentConfigurationException)
                return buildMaskError(mapper, "CONFIG_ERROR", cause.getMessage());
            return buildMaskError(mapper, "ERROR", cause.getClass().getSimpleName() + ": " + cause.getMessage());
        } catch (Exception e) {
            return buildMaskError(mapper, "ERROR", e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }

    @SuppressWarnings("unchecked")
    static JsonNode handleMaskBatch(ObjectMapper mapper, JsonNode req) {
        try {
            String className = req.get("algorithm").asText();
            String configJson = req.has("config") && !req.get("config").isNull()
                    ? mapper.writeValueAsString(req.get("config")) : "{}";
            String keyString = req.has("key") ? req.get("key").asText() : "delphix-default-key";
            JsonNode inputsNode = req.get("inputs");

            final int size = inputsNode.size();
            final Object[] inputs = new Object[size];
            for (int i = 0; i < size; i++) inputs[i] = inputsNode.get(i).asText();
            final Object[] outputs = new Object[size];
            final String[] errors = new String[size];

            MaskingComponent component = instantiate(className);
            if (!configJson.equals("{}")) {
                configJson = configJson.replaceAll(
                    "(\\d{4}-\\d{2}-\\d{2})T(\\d{2}:\\d{2}:\\d{2})", "$1 $2");
                ComponentConfigurator.applyConfiguration(component, configJson);
            }
            Map<String, MaskingAlgorithm<?>> registry = new HashMap<>();
            ComponentService service = buildService(keyString, mapper, registry);
            setupRecursive(component, service, registry);
            component.validate();

            com.delphix.masking.api.plugin.MaskingBatch batch =
                new com.delphix.masking.api.plugin.MaskingBatch() {
                    @Override public int size() { return size; }
                    @Override public Object getValue(int i) { return inputs[i]; }
                    @Override public void setValue(int i, Object v) { outputs[i] = v; }
                    @Override public void setError(int i,
                            com.delphix.masking.api.plugin.exception.MaskingException e) {
                        errors[i] = e.getMessage();
                    }
                };

            ((MaskingAlgorithm<?>) component).maskBatch(batch);

            ArrayNode arr = mapper.createArrayNode();
            for (int i = 0; i < size; i++) {
                ObjectNode row = mapper.createObjectNode();
                if (errors[i] != null) {
                    row.put("error", errors[i]);
                } else {
                    row.put("output", outputs[i] != null ? outputs[i].toString() : (String) null);
                }
                arr.add(row);
            }
            ObjectNode result = mapper.createObjectNode();
            result.set("results", arr);
            return result;

        } catch (java.lang.reflect.InvocationTargetException e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            return buildMaskError(mapper, "ERROR", cause.getClass().getSimpleName() + ": " + cause.getMessage());
        } catch (Exception e) {
            return buildMaskError(mapper, "ERROR", e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }

    @SuppressWarnings("unchecked")
    static void setupRecursive(MaskingComponent component, ComponentService service,
            Map<String, MaskingAlgorithm<?>> registry) throws Exception {
        setupRecursive(component, service, registry, new java.util.HashSet<>());
    }

    // Returns true if the component was actually set up, false if skipped (cycle detected).
    // Only components that return true should be added to the algorithm registry, to avoid
    // registering un-initialized instances that would fail with null crypto at mask time.
    @SuppressWarnings("unchecked")
    static boolean setupRecursive(MaskingComponent component, ComponentService service,
            Map<String, MaskingAlgorithm<?>> registry, Set<String> inProgress) throws Exception {
        // DFS path-based cycle detection: track what's currently being processed in this call
        // chain. Adding on entry and removing on exit allows sibling instances of the same class
        // (e.g. firstName and lastName both of type Name) to each be set up independently,
        // while still blocking true cycles (e.g. FullName whose getDefaultInstances() creates
        // a fresh FullName, which would cause infinite recursion).
        String className = component.getClass().getName();
        if (inProgress.contains(className)) return false;
        inProgress.add(className);

        java.util.Collection<MaskingComponent> defaults = component.getDefaultInstances();
        if (defaults != null) {
            for (MaskingComponent sub : defaults) {
                boolean wasSetup = setupRecursive(sub, service, registry, inProgress);
                // Only register sub-algorithms that were actually set up; skipped (cycle)
                // instances have null crypto and would cause NPE when called during mask().
                if (wasSetup && sub instanceof MaskingAlgorithm) {
                    registry.put(sub.getName(), (MaskingAlgorithm<?>) sub);
                }
            }
        }
        component.setup(service);
        inProgress.remove(className);
        return true;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    // Calls mask() via reflection, converting the String input to whatever type the algorithm expects.
    @SuppressWarnings("unchecked")
    static String invokeMask(MaskingComponent component, String input) throws Exception {
        // Find the real (non-bridge) mask method to discover the expected parameter type.
        java.lang.reflect.Method maskMethod = null;
        java.lang.reflect.Method bridgeMethod = null;
        for (java.lang.reflect.Method m : component.getClass().getMethods()) {
            if ("mask".equals(m.getName()) && m.getParameterCount() == 1) {
                if (!m.isBridge()) { maskMethod = m; break; }
                else if (bridgeMethod == null) { bridgeMethod = m; }
            }
        }
        // Some algorithms (e.g. Encryption, DateConverter) declare mask() as private, so only
        // the compiler-generated bridge appears in getMethods(). In that case, find the real
        // parameter type via getDeclaredMethods (for type coercion), then invoke through the
        // public bridge (which calls the private impl internally — no cross-module access issue).
        if (maskMethod == null && bridgeMethod != null) {
            Class<?> cls = component.getClass();
            while (cls != null) {
                for (java.lang.reflect.Method m : cls.getDeclaredMethods()) {
                    if ("mask".equals(m.getName()) && m.getParameterCount() == 1 && !m.isBridge()) {
                        maskMethod = m; break;
                    }
                }
                if (maskMethod != null) break;
                cls = cls.getSuperclass();
            }
        }
        // Determine which method to actually invoke: prefer bridge for private impls.
        final java.lang.reflect.Method invokeMethod = (maskMethod != null && java.lang.reflect.Modifier.isPublic(maskMethod.getModifiers()))
            ? maskMethod : (bridgeMethod != null ? bridgeMethod : maskMethod);
        if (invokeMethod == null) {
            return ((MaskingAlgorithm<String>) component).mask(input);
        }

        // Use maskMethod for type detection (may be private), invokeMethod for actual call (must be public).
        Class<?> paramType = maskMethod != null ? maskMethod.getParameterTypes()[0] : invokeMethod.getParameterTypes()[0];
        Object inputObj;
        try {
            if (paramType == java.math.BigDecimal.class) {
                inputObj = new java.math.BigDecimal(input.trim());
            } else if (paramType == Long.class || paramType == long.class) {
                inputObj = Long.parseLong(input.trim());
            } else if (paramType == java.time.LocalDateTime.class) {
                inputObj = parseLocalDateTime(input.trim());
            } else if (paramType == java.time.LocalDate.class) {
                inputObj = java.time.LocalDate.parse(input.trim());
            } else {
                inputObj = input;
            }
        } catch (NumberFormatException | java.time.format.DateTimeParseException e) {
            throw new NonConformantDataException(
                "Input cannot be converted to " + paramType.getSimpleName() + ": " + e.getMessage());
        }

        Object result = invokeMethod.invoke(component, inputObj);
        return result != null ? result.toString() : null;
    }

    static java.time.LocalDateTime parseLocalDateTime(String s) {
        java.time.format.DateTimeFormatter[] fmts = {
            java.time.format.DateTimeFormatter.ISO_LOCAL_DATE_TIME,
            java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss"),
            java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm"),
            java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm"),
        };
        for (java.time.format.DateTimeFormatter fmt : fmts) {
            try { return java.time.LocalDateTime.parse(s, fmt); } catch (Exception ignored) {}
        }
        // Accept date-only strings (e.g. "2024-03-15") by treating them as midnight.
        try { return java.time.LocalDate.parse(s).atStartOfDay(); } catch (Exception ignored) {}
        throw new java.time.format.DateTimeParseException("Cannot parse date-time: " + s, s, 0);
    }

    /**
     * Injects default algorithm references for missing date/numeric/binary slots in each
     * MultiColumnCondition condition. This works around a plugin bug where getDateAlgorithm()
     * NPEs when those slots are absent and fallbackType is null (standalone runner only).
     */
    static String injectMultiColumnDefaults(ObjectMapper mapper, String configJson) {
        try {
            JsonNode root = mapper.readTree(configJson);
            if (!root.has("conditions") || !root.get("conditions").isArray()) return configJson;

            // Default refs — must match the getName() values from the plugin's builtin catalog
            ObjectNode dateDefault   = mapper.createObjectNode(); dateDefault.put("name", "Date Shift Discrete");
            ObjectNode numericDefault = mapper.createObjectNode(); numericDefault.put("name", "CM Numeric");
            ObjectNode binaryDefault = mapper.createObjectNode(); binaryDefault.put("name", "Null Secure Lookup");

            ObjectNode rootObj = (ObjectNode) root;
            ArrayNode conditions = (ArrayNode) root.get("conditions");
            for (int i = 0; i < conditions.size(); i++) {
                ObjectNode cond = (ObjectNode) conditions.get(i);
                // Only fill first slot of each type; the plugin iterates all three but the NPE
                // happens even if just one is missing, so we pre-fill the minimum needed.
                for (int n = 1; n <= 3; n++) {
                    if (!cond.has("date" + n))    cond.set("date" + n, dateDefault.deepCopy());
                    if (!cond.has("numeric" + n)) cond.set("numeric" + n, numericDefault.deepCopy());
                    if (!cond.has("binary" + n))  cond.set("binary" + n, binaryDefault.deepCopy());
                }
            }
            return mapper.writeValueAsString(rootObj);
        } catch (Exception e) {
            return configJson; // on any parse error, return unchanged
        }
    }

    /**
     * Returns the algorithm's native masking type by inspecting the mask() method parameter.
     * Returns null if the type cannot be determined.
     */
    @SuppressWarnings("unchecked")
    static MaskingAlgorithm.MaskingType getAlgorithmNativeMaskingType(MaskingAlgorithm<?> alg) {
        for (java.lang.reflect.Method m : alg.getClass().getMethods()) {
            if ("mask".equals(m.getName()) && m.getParameterCount() == 1 && !m.isBridge()) {
                Class<?> paramType = m.getParameterTypes()[0];
                if (paramType == Object.class) return MaskingAlgorithm.MaskingType.ADVANCED_OBJECT;
                try { return MaskingAlgorithm.MaskingType.getByClass(paramType); } catch (Exception ignore) {}
                break;
            }
        }
        return null;
    }

    /**
     * Wraps an algorithm with TypeAdaptingComponentWrapper when its native type doesn't match
     * the requested type. This mirrors what the Masking Engine does so that algorithms like
     * MultiColumnCondition receive correctly-typed algorithm references.
     */
    @SuppressWarnings({"unchecked","rawtypes"})
    static MaskingAlgorithm<?> adaptAlgorithmType(MaskingAlgorithm<?> alg,
            MaskingAlgorithm.MaskingType requestedType) {
        if (requestedType == null) return alg;
        if (alg instanceof TypeAdaptingComponentWrapper) return alg;
        MaskingAlgorithm.MaskingType nativeType = getAlgorithmNativeMaskingType(alg);
        if (nativeType == null || nativeType == requestedType) return alg;
        MaskValueMetadataImpl wrapMeta = new MaskValueMetadataImpl().maskingType(requestedType);
        return new TypeAdaptingComponentWrapper(nativeType, requestedType, (MaskingAlgorithm) alg, wrapMeta);
    }

    static MaskingComponent instantiate(String className) throws Exception {
        // Always use the plugin classloader so that default sub-algorithm instances
        // (e.g. FullName → FirstName) share the same class identity and don't
        // produce ClassCastException when mixing system-loader and plugin-loader types.
        ClassLoader cl = getPluginClassLoader();
        Class<?> clazz = Class.forName(className, true, cl);
        return (MaskingComponent) clazz.getDeclaredConstructor().newInstance();
    }

    static ClassLoader getPluginClassLoader() throws Exception {
        Map<String, MaskingComponent> catalog = getBuiltinCatalog();
        if (!catalog.isEmpty()) {
            return catalog.values().iterator().next().getClass().getClassLoader();
        }
        return AlgorithmRunner.class.getClassLoader();
    }

    static ObjectNode error(ObjectMapper mapper, String message) {
        ObjectNode n = mapper.createObjectNode();
        n.put("error", message);
        return n;
    }

    static ObjectNode buildMaskError(ObjectMapper mapper, String type, String message) {
        ObjectNode n = mapper.createObjectNode();
        n.put("errorType", type);
        n.put("error", message);
        return n;
    }

    static ComponentService buildService(String keyString, ObjectMapper mapper,
            Map<String, MaskingAlgorithm<?>> registry) {
        return buildService(keyString, mapper, registry, Collections.emptyMap());
    }

    static ComponentService buildService(String keyString, ObjectMapper mapper,
            Map<String, MaskingAlgorithm<?>> registry, Map<String, JsonNode> extraAlgos) {
        byte[] rawKey = keyString.getBytes(StandardCharsets.UTF_8);
        // AES requires exactly 16, 24, or 32 bytes. Normalize to the nearest valid length
        // (pad with zeros if short, truncate if longer than 32).
        int keyLen = rawKey.length;
        int targetLen = keyLen <= 16 ? 16 : keyLen <= 24 ? 24 : 32;
        rawKey = Arrays.copyOf(rawKey, targetLen);
        final byte[] keyBytes = rawKey;

        return new ComponentService() {

            @Override
            public String getInstanceName() { return "test"; }

            @Override
            public CryptoService getCryptoService(KeyReference ref) {
                return new CryptoServiceImpl(keyBytes);
            }

            @Override
            public LogService getLogService() {
                return new LogService() {
                    @Override
                    public void info(Integer jobId, Integer execId, String msg, Object... params) {}
                    @Override
                    public void debug(Integer jobId, Integer execId, String msg, Object... params) {}
                    @Override
                    public void warn(Integer jobId, Integer execId, String msg, Object... params) {}
                    @Override
                    public void error(Integer jobId, Integer execId, String msg, Object... params) {}
                };
            }

            @Override
            public MaskValueMetadata getMaskValueMetadata() { return null; }

            @Override
            public ExpressionEvaluator createJaninoExpressionEvaluator() {
                return new ExpressionEvaluator();
            }

            @Override
            public void cookJaninoExpression(ExpressionEvaluator ev, String expr)
                    throws org.codehaus.commons.compiler.CompileException {
                ev.cook(expr);
            }

            @Override
            @SuppressWarnings("unchecked")
            public MaskingAlgorithm<?> getAlgorithmByName(AlgorithmInstanceReference ref,
                    MaskingAlgorithm.MaskingType type) {
                String refName = ref.getValue();
                // Try exact match first, then strip plugin prefix (e.g. "dlpx-core:CM Numeric" → "CM Numeric")
                MaskingAlgorithm<?> alg = registry.get(refName);
                if (alg == null) {
                    int sep = refName.indexOf(PluginLoader.COMPONENT_SCOPE_SEPARATOR);
                    String shortName = sep >= 0 ? refName.substring(sep + 1) : refName;
                    alg = registry.get(shortName);
                    if (alg == null) {
                        // Lazy: look up in builtin catalog, set up on demand
                        try {
                            Map<String, MaskingComponent> catalog = getBuiltinCatalog();
                            MaskingComponent comp = catalog.get(refName);
                            if (comp == null) comp = catalog.get(shortName);
                            if (comp != null) {
                                setupRecursive(comp, this, registry);
                                alg = (MaskingAlgorithm<?>) comp;
                                registry.put(shortName, alg);
                            }
                        } catch (Exception e) {
                            Throwable cause = e;
                            while (cause.getCause() != null) cause = cause.getCause();
                            throw new RuntimeException("Failed to setup sub-algorithm: " + refName
                                + " — " + cause.getClass().getSimpleName() + ": " + cause.getMessage(), e);
                        }
                    }
                    // Resolve from additionalAlgorithms (saved tests passed by the frontend)
                    if (alg == null && !extraAlgos.isEmpty()) {
                        JsonNode extra = extraAlgos.get(refName);
                        if (extra == null) extra = extraAlgos.get(shortName);
                        if (extra != null) {
                            try {
                                String extraClass = extra.get("className").asText();
                                MaskingComponent comp = instantiate(extraClass);
                                if (extra.has("config") && !extra.get("config").isNull()) {
                                    String extraCfg = mapper.writeValueAsString(extra.get("config"));
                                    if (!extraCfg.equals("{}") && !extraCfg.equals("null")) {
                                        extraCfg = extraCfg.replaceAll(
                                            "(\\d{4}-\\d{2}-\\d{2})T(\\d{2}:\\d{2}:\\d{2})", "$1 $2");
                                        ComponentConfigurator.applyConfiguration(comp, extraCfg);
                                    }
                                }
                                setupRecursive(comp, this, registry);
                                alg = (MaskingAlgorithm<?>) comp;
                                registry.put(refName, alg);
                                if (!shortName.equals(refName)) registry.put(shortName, alg);
                            } catch (Exception e) {
                                Throwable cause = e;
                                while (cause.getCause() != null) cause = cause.getCause();
                                throw new RuntimeException("Failed to setup saved algorithm '" + refName
                                    + "': " + cause.getClass().getSimpleName() + ": " + cause.getMessage(), e);
                            }
                        }
                    }
                }

                if (alg == null) throw new RuntimeException(
                    "Sub-algorithm not found: " + refName);

                // Type-compatibility bridging: if the algorithm's native type doesn't match the
                // requested type, wrap it with TypeAdaptingComponentWrapper so that the caller
                // (e.g. MultiColumnCondition) sees the correct external masking type. This mirrors
                // what the real Masking Engine does when registering algorithms for multi-column use.
                alg = adaptAlgorithmType(alg, type);

                return alg;
            }

            @Override
            public MaskingAlgorithm<?> getAlgorithmByName(AlgorithmInstanceReference ref,
                    MaskingAlgorithm.MaskingType type, MaskValueMetadata meta) {
                return getAlgorithmByName(ref, type);
            }

            @Override
            @SuppressWarnings("unchecked")
            public MaskingAlgorithm.MaskingType getMaskingTypeForInstanceReference(AlgorithmInstanceReference ref) {
                String refName = ref.getValue();
                int sep = refName.indexOf(PluginLoader.COMPONENT_SCOPE_SEPARATOR);
                String shortName = sep >= 0 ? refName.substring(sep + 1) : refName;
                MaskingAlgorithm<?> alg = registry.get(refName);
                if (alg == null) alg = registry.get(shortName);
                if (alg == null) {
                    try {
                        Map<String, MaskingComponent> catalog = getBuiltinCatalog();
                        MaskingComponent comp = catalog.get(refName);
                        if (comp == null) comp = catalog.get(shortName);
                        if (comp instanceof MaskingAlgorithm) alg = (MaskingAlgorithm<?>) comp;
                    } catch (Exception ignore) {}
                }
                if (alg != null) {
                    MaskingAlgorithm.MaskingType t = getAlgorithmNativeMaskingType(alg);
                    if (t != null) return t;
                }
                return MaskingAlgorithm.MaskingType.STRING;
            }

            @Override
            public InputStream openInputFile(FileReference ref) {
                try {
                    String uriStr = ref.getValue();
                    // Built-in plugin resources use "jar://file/<entry>" to reference
                    // files embedded inside the plugin JAR itself.
                    if (uriStr.startsWith("jar://file/")) {
                        String entry = uriStr.substring("jar://file/".length());
                        java.util.jar.JarFile jar = new java.util.jar.JarFile(
                            new java.io.File(PLUGIN_JAR_PATH));
                        java.util.zip.ZipEntry ze = jar.getEntry(entry);
                        if (ze == null) {
                            jar.close();
                            throw new RuntimeException("Resource '" + entry + "' not found in plugin JAR");
                        }
                        final InputStream inner = jar.getInputStream(ze);
                        return new java.io.FilterInputStream(inner) {
                            @Override public void close() throws java.io.IOException {
                                super.close(); jar.close();
                            }
                        };
                    }
                    java.io.File file;
                    if (uriStr.startsWith("file://")) {
                        // Strip "file://" and decode percent-encoded chars (e.g. %20 → space).
                        // This handles both pre-encoded URIs and URIs with raw spaces.
                        String decoded = java.net.URLDecoder.decode(
                            uriStr.substring("file://".length()), "UTF-8");
                        file = new java.io.File(decoded);
                    } else {
                        file = new java.io.File(new java.net.URI(uriStr));
                    }
                    return new FileInputStream(file);
                } catch (Exception e) {
                    throw new RuntimeException(
                        "Cannot open file '" + ref.getValue() + "': " + e.getMessage(), e);
                }
            }

            @Override
            public Connection openJdbcConnection(JdbcReference ref) {
                throw new UnsupportedOperationException("JDBC references are not supported");
            }

            @Override
            public Connection openMappingConnection(MappingSetReference ref) {
                throw new UnsupportedOperationException("Mapping set references are not supported");
            }

            @Override
            public com.delphix.masking.api.driverSupport.jobInfo.JobInfo getJobInfo() { return null; }

            @Override
            public Connection getTargetConnection() { return null; }

            @Override
            public com.delphix.masking.api.driverSupport.taskInfo.SingleOperationTaskInfo getSingleOperationTaskInfo() { return null; }

            @Override
            public GeneratorAlgorithm<?> createEmbeddedGenerator(EmbeddedGeneratorReference ref,
                    MaskingAlgorithm.MaskingType type) {
                throw new UnsupportedOperationException("Embedded generators are not supported");
            }
        };
    }
}
