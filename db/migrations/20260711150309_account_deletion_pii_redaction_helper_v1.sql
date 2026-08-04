CREATE OR REPLACE FUNCTION app_private.fn_redact_account_pii_jsonb_v1(p_value jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE STRICT
 SET search_path TO 'pg_catalog', 'app_private'
AS $function$
DECLARE
  v_type text;
  v_result jsonb;
  v_key text;
  v_item jsonb;
  v_key_normalized text;
BEGIN
  v_type := jsonb_typeof(p_value);

  IF v_type = 'object' THEN
    v_result := '{}'::jsonb;

    FOR v_key, v_item IN
      SELECT key, value
      FROM jsonb_each(p_value)
    LOOP
      v_key_normalized := lower(v_key);

      IF v_key_normalized = ANY (ARRAY[
        'nombre', 'nombres', 'apellidos', 'nombre_completo', 'nombre_cliente',
        'cliente_nombre', 'titular_nombre', 'titular_nombre_snapshot',
        'receptor_nombre', 'receptor_nombre_snapshot', 'contacto_nombre',
        'contacto_nombre_snapshot', 'nombre_destinatario',
        'nombre_destinatario_snapshot',
        'email', 'correo', 'direccion_correo', 'correo_destino', 'email_factura',
        'titular_email', 'titular_email_snapshot', 'receptor_email',
        'receptor_email_snapshot', 'contacto_email', 'contacto_email_snapshot',
        'email_destinatario_snapshot', 'email_masked',
        'telefono', 'telefono_principal', 'telefono_cliente', 'titular_telefono',
        'titular_telefono_snapshot', 'receptor_telefono',
        'receptor_telefono_snapshot', 'contacto_telefono',
        'contacto_telefono_snapshot', 'celular', 'phone',
        'dni', 'rtn', 'identidad', 'documento', 'numero_documento',
        'direccion', 'direccion_texto', 'address', 'fecha_nacimiento',
        'birth_date', 'birthdate', 'genero_codigo',
        'observaciones', 'notas', 'comentario', 'comentarios', 'cuerpo',
        'mensaje', 'detalle_tecnico', 'ultimo_error',
        'email_ultimo_error_detalle', 'ultimo_error_detalle',
        'foto_perfil_path', 'foto_perfil_asset_id', 'avatar_url', 'foto',
        'imagen_perfil', 'release_token', 'release_token_hash', 'token',
        'access_token', 'refresh_token', 'token_jti_hash', 'ip', 'ip_inicio',
        'ip_ultimo_uso', 'last_login_ip', 'user_agent', 'identificador_hash',
        'public_url', 'object_path', 'original_filename'
      ]::text[]) THEN
        IF v_key_normalized = ANY (ARRAY[
          'nombre', 'nombres', 'apellidos', 'nombre_completo', 'nombre_cliente',
          'cliente_nombre', 'titular_nombre', 'titular_nombre_snapshot',
          'receptor_nombre', 'receptor_nombre_snapshot', 'contacto_nombre',
          'contacto_nombre_snapshot', 'nombre_destinatario',
          'nombre_destinatario_snapshot'
        ]::text[]) THEN
          v_result := v_result || jsonb_build_object(v_key, 'Cliente eliminado');
        ELSE
          v_result := v_result || jsonb_build_object(v_key, 'null'::jsonb);
        END IF;
      ELSE
        v_result := v_result || jsonb_build_object(
          v_key,
          app_private.fn_redact_account_pii_jsonb_v1(v_item)
        );
      END IF;
    END LOOP;

    RETURN v_result;
  END IF;

  IF v_type = 'array' THEN
    SELECT COALESCE(
      jsonb_agg(app_private.fn_redact_account_pii_jsonb_v1(value)),
      '[]'::jsonb
    )
    INTO v_result
    FROM jsonb_array_elements(p_value);

    RETURN v_result;
  END IF;

  RETURN p_value;
END;
$function$;

COMMENT ON FUNCTION app_private.fn_redact_account_pii_jsonb_v1(jsonb) IS
  'Redacta claves conocidas de PII en documentos JSON preservando su estructura operativa.';

REVOKE ALL ON FUNCTION app_private.fn_redact_account_pii_jsonb_v1(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
